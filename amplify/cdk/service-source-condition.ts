// Excerpt from amplify/backend.ts (Arsenal production CDK). Shown standalone:
// in the real file `backend` is the Amplify Gen 2 backend object returned by
// defineBackend(), and this Aspect is applied once at the CDK app root.
import { Aspects, CfnResource, Stack, type IAspect } from 'aws-cdk-lib';
import { CfnRole } from 'aws-cdk-lib/aws-iam';
import type { IConstruct } from 'constructs';

declare const backend: any; // provided by defineBackend() in the real file

// ── Service role trust: confused-deputy conditions ───────────────────────────
//
// Every role in this backend that a service assumes was generated with a trust
// policy that says `<service>.amazonaws.com may sts:AssumeRole` and nothing
// else. Prowler's iam_role_cross_service_confused_deputy_prevention flags 127
// of them, which is 94% of every high finding in the account.
//
// It is worth being precise about which of those are real, because "the scanner
// says so" is not a reason and applying a control everywhere it is flagged is
// cargo-culting it. Two different cases are in that pile:
//
//   AppSync data-source roles are assumed ON BEHALF OF a specific API, so an
//   unconditioned trust literally reads "any AppSync API, in any account, may
//   use this role". That is the textbook confused deputy.
//
//   Lambda EXECUTION roles are assumed by the service for our own function, in
//   our own account, with no third party to confuse. The condition buys much
//   less here, and AWS documents aws:SourceArn for Lambda RESOURCE policies —
//   who may invoke a function — not for the execution role's trust policy. The
//   real question was whether adding it BREAKS invocation, because if STS does
//   not populate the key the condition denies and every function stops at once.
//
// That question was settled by experiment rather than by argument, in the
// sandbox account on 2026-09-07: a throwaway role and function, three trust
// policies, each function deleted and recreated so the role is assumed fresh.
// No condition, aws:SourceAccount alone, and aws:SourceAccount + aws:SourceArn
// all created and invoked successfully. The control ran first and passed, so
// the harness was sound and IAM propagation was not a variable. It works, so it
// goes on — defence in depth that costs nothing beats an accept built on a
// guess.
//
// The EventBridge Scheduler roles in this account already carry exactly this
// pair, emitted by CDK. The pattern is not exotic here; it was simply never
// applied to the services below.
//
// An Aspect rather than ~124 escape hatches, for the same reason the PITR block
// above enumerates rather than lists: a model, a custom operation or a function
// added next month is covered because it exists, not because someone remembered.
class ServiceSourceCondition implements IAspect {
  public matched = 0;
  /** principal → the aws:SourceArn pattern its roles should be pinned to. */
  constructor(private readonly patterns: Record<string, string>) {}

  /**
   * The trust document, however the role was built. A typed CfnRole exposes it
   * directly; a raw CfnResource keeps it in cfnProperties. Returns undefined
   * rather than guessing if neither is readable — this only ever edits a
   * document it has actually read, so a shape it does not understand is left
   * alone and shows up as an unconditioned role in the count instead of being
   * silently mangled.
   */
  private readTrust(node: CfnResource, stack: Stack):
      { Statement?: Array<Record<string, any>> } | undefined {
    const raw = node instanceof CfnRole
      ? node.assumeRolePolicyDocument
      : (node as unknown as { cfnProperties?: Record<string, unknown> })
          .cfnProperties?.AssumeRolePolicyDocument;
    return raw ? (stack.resolve(raw) as { Statement?: Array<Record<string, any>> }) : undefined;
  }

  public visit(node: IConstruct): void {
    // NOT `instanceof CfnRole`. CDK's CustomResourceProvider (the S3
    // auto-delete-objects helper, among others) emits its role as a bare
    // CfnResource of type AWS::IAM::Role, so an instanceof check silently
    // skips it — which is exactly how the first version of this missed two
    // roles while reporting success on the other 122.
    if (!CfnResource.isCfnResource(node) || node.cfnResourceType !== 'AWS::IAM::Role') return;
    const stack = Stack.of(node);
    const doc = this.readTrust(node, stack);
    if (!doc?.Statement) return;

    let touched = false;
    for (const st of doc.Statement) {
      const services: string[] = ([] as string[]).concat(st.Principal?.Service ?? []);
      const principal = services.find((s) => s in this.patterns);
      if (!principal) continue;
      // Merge, never replace. If CDK ever starts emitting its own condition on
      // these roles, clobbering it would be a silent downgrade that still reads
      // as "fixed" to the scanner.
      const cond: Record<string, Record<string, unknown>> = st.Condition ?? {};
      cond.StringEquals = { ...(cond.StringEquals ?? {}), 'aws:SourceAccount': stack.account };
      cond.ArnLike = { ...(cond.ArnLike ?? {}), 'aws:SourceArn': this.patterns[principal] };
      st.Condition = cond;
      touched = true;
    }
    if (touched) {
      node.addPropertyOverride('AssumeRolePolicyDocument', doc);
      this.matched++;
    }
  }
}

// ArnLike with a wildcard, never StringEquals on an exact ARN. The source ARN a
// service presents is not contractually fixed, and an ARN condition one path
// segment too strict does not degrade — it denies every assumption and takes the
// API (or every Lambda) down at once. The wildcard still pins the account, the
// region and the service, which is the entire confused-deputy property. A second
// API in this same account whose id shares this one's prefix is not a threat
// worth that blast radius.
//
// Lambda and Step Functions are pinned by service rather than by individual
// resource on purpose: a role does not know which function it belongs to at
// synth, and account+region+service is the property being bought either way.
const trustConditions = new ServiceSourceCondition({
  'appsync.amazonaws.com': `${backend.data.resources.graphqlApi.arn}*`,
  'lambda.amazonaws.com': `arn:${backend.stack.partition}:lambda:${backend.stack.region}:${backend.stack.account}:function:*`,
  'states.amazonaws.com': `arn:${backend.stack.partition}:states:${backend.stack.region}:${backend.stack.account}:stateMachine:*`,
  'scheduler.amazonaws.com': `arn:${backend.stack.partition}:scheduler:${backend.stack.region}:${backend.stack.account}:schedule/*`,
});
// Applied at the app root, not at backend.stack. The custom stacks made with
// backend.createStack() are SIBLINGS of the main stack under the CDK App, not
// children of it, so anchoring here is the difference between covering the whole
// backend and quietly covering most of it.
Aspects.of(backend.stack.node.root).add(trustConditions);
