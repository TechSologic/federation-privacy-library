# Maintainer Repository Setup

Maintainers configure repository access, review, reporting and publishing
separately from repository content. Record completion of the relevant checks
with evidence; this checklist does not assert remote configuration or legal review.

## Before Accepting External Original Contributions

- [ ] Review the [CLA](../../../CONTRIBUTOR_LICENSE_AGREEMENT.md), resolve its draft
      status, and preserve the reviewed revision.
- [ ] Establish the [CLA acceptance records](../legal/cla-records.md).
- [ ] Record authorized maintainer and release roles in
      [MAINTAINERS.md](../../../MAINTAINERS.md).
- [ ] Verify access to the TechSologic project contact and private
      security-reporting workflow.
- [ ] Require pull requests and an approving review for ordinary changes to
      the default branch. Restrict force pushes and branch deletion.
- [ ] Configure required checks only after the corresponding workflows have run
      successfully on GitHub. Local workflow files do not establish remote results.
- [ ] Restrict administrative bypass and publishing permissions to designated
      responsibilities; use protected release credentials and minimal workflow
      permissions.

## Before Making The Repository Public

- [ ] Review all reachable Git history and files for secrets, private operational
      material, third-party notices, and inaccurate status claims.
- [ ] Confirm the public README, license, reporting contacts, contribution terms,
      and issue/PR templates describe this project.
- [ ] Enable and exercise GitHub private vulnerability reporting when available.
      Repository administrators must configure this separately from `SECURITY.md`.
- [ ] Confirm maintainers receive private-report notifications.
- [ ] Confirm the published maintainer and successor designations match authorized
      appointments and asset-transfer arrangements.
- [ ] Review available dependency and secret-protection settings for the actual
      repository plan and visibility.
- [ ] Change repository visibility only through an explicitly authorized action.

GitHub's [private reporting configuration guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)
describes the reporting setting. Its
[repository security settings guide](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-security-and-analysis-settings-for-your-repository)
describes features whose availability depends on visibility and account settings.

## Before Publishing A Library Release

- [ ] Review the public interfaces, supported runtime, stream type,
      protocol compatibility, and operation semantics.
- [ ] Verify package metadata, the lockfile, build/type checks, focused tests and
      CI work from this checkout alone.
- [ ] Review adapted code and dependency licenses, notices and source
      obligations.
- [ ] Verify the interoperability claimed for the release using synthetic data.
- [ ] Define supported versions, security response ownership, and update policy.
- [ ] Review security claims against the evidence actually produced.
- [ ] Verify the selected package name, authorized publisher, package contents,
      source revision, and artifact provenance.
- [ ] Follow the [npm release setup](releases.md), verify the manual validation
      run, and configure trusted publishing before enabling automated publication.
- [ ] Record release evidence and update the changelog and README.

Do not mark an item complete merely because a document describes it. Keep private
credentials, acceptance evidence requiring restricted access, and operational
access inventories out of public Git history.
