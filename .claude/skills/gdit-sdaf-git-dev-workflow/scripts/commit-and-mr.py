#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///

"""
Git Commit and Merge/Pull Request
Creates dev-{username} branch, validates, commits, pushes, and creates merge/pull request.
Auto-detects remote provider (GitLab, GitHub, CodeCommit, Bitbucket) and uses appropriate PR mechanism.
"""

import subprocess
import sys
import json
from pathlib import Path
from datetime import datetime
from skill_config import load_config, detect_provider, load_credentials, ensure_project_yaml_remote
from credential_manager import push_with_credentials, git_with_credentials, mask_tokens

SCRIPT_DIR = Path(__file__).parent

def run_git(cmd):
    """Run git command"""
    result = subprocess.run(f"git {cmd}", shell=True, capture_output=True, text=True)
    return result.returncode, result.stdout.strip(), result.stderr.strip()

def create_codecommit_pr(repo_name, branch_name, default_branch, title, description, profile=None):
    """Create a pull request via AWS CodeCommit CLI"""
    targets = json.dumps([{
        "repositoryName": repo_name,
        "sourceReference": branch_name,
        "destinationReference": default_branch
    }])
    cmd = [
        "aws", "codecommit", "create-pull-request",
        "--title", title,
        "--description", description,
        "--targets", targets
    ]
    if profile:
        cmd.extend(["--profile", profile])

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        try:
            pr_data = json.loads(result.stdout)
            pr_id = pr_data["pullRequest"]["pullRequestId"]
            return True, pr_id
        except (json.JSONDecodeError, KeyError):
            return True, None
    return False, result.stderr.strip()


def codecommit_has_branch_protection(repo_name, profile=None):
    """Check if CodeCommit repo has approval rule templates (branch protection)."""
    cmd = ["aws", "codecommit", "list-associated-approval-rule-templates-for-repository",
           "--repository-name", repo_name]
    if profile:
        cmd.extend(["--profile", profile])
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return True  # Assume protected if we can't check
    try:
        data = json.loads(result.stdout)
        return len(data.get("approvalRuleTemplateNames", [])) > 0
    except (json.JSONDecodeError, KeyError):
        return True


def merge_codecommit_pr(repo_name, pr_id, source_commit, profile=None):
    """Merge a CodeCommit PR via fast-forward."""
    cmd = ["aws", "codecommit", "merge-pull-request-by-fast-forward",
           "--pull-request-id", str(pr_id),
           "--repository-name", repo_name,
           "--source-commit-id", source_commit]
    if profile:
        cmd.extend(["--profile", profile])
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        return True, None
    # Try squash if fast-forward fails
    cmd[2] = "merge-pull-request-by-squash"
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        return True, None
    return False, result.stderr.strip()


def create_gitlab_mr(push_target, branch_name, default_branch, title, description):
    """Create merge request via GitLab push options"""
    code, out, err = run_git(
        f'push -o merge_request.create '
        f'-o merge_request.target={default_branch} '
        f'-o merge_request.title="{title}" '
        f'-o merge_request.description="{description}" '
        f'-o merge_request.remove_source_branch '
        f'{push_target} {branch_name}'
    )
    return code == 0, out or err

def main():
    # Auto-configure project.yaml if git-remote section is missing
    ensure_project_yaml_remote()

    # Parse arguments
    skip_validation = "--skip-validation" in sys.argv
    commit_msg = None
    mr_title = None
    mr_desc = None
    remote_override = None

    i = 1
    while i < len(sys.argv):
        if sys.argv[i] == "--message" and i + 1 < len(sys.argv):
            commit_msg = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--title" and i + 1 < len(sys.argv):
            mr_title = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--description" and i + 1 < len(sys.argv):
            mr_desc = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--remote" and i + 1 < len(sys.argv):
            remote_override = sys.argv[i + 1]
            i += 2
        else:
            i += 1

    # Load config
    cfg = load_config(remote_override=remote_override)
    remote = cfg["remote_name"]
    default_branch = cfg["default_branch"]

    # Detect provider
    provider, provider_meta = detect_provider(remote, provider_override=cfg.get("provider_override"))
    print(f"=== Git Commit and {'Pull' if provider in ('github', 'codecommit') else 'Merge'} Request ===\n")
    print(f"Provider: {provider}")

    # Determine username — prefer existing dev branch, then git config, then getpass
    username = None
    code, branches, _ = run_git("branch --list 'dev-*'")
    existing_dev = [b.strip().lstrip("* ") for b in branches.split("\n") if b.strip()] if branches else []
    if existing_dev:
        branch_name = existing_dev[0]
        username = branch_name.removeprefix("dev-")
    else:
        code, git_user, _ = run_git("config user.name")
        if code == 0 and git_user:
            username = git_user.split()[0].lower()
        else:
            import getpass
            raw = getpass.getuser()
            username = raw.split("@")[0].split(".")[0].lower()
        branch_name = f"dev-{username}"

    # Load credentials for remote auth
    creds_all = load_credentials()
    code, remote_url, _ = run_git(f"remote get-url {remote}")
    base_url = None
    push_creds = None
    if code == 0 and remote_url.startswith("https://"):
        host = remote_url.replace("https://", "").split("/")[0].split("@")[-1]
        base_url = f"https://{host}"
        push_creds = creds_all.get(base_url)
        if push_creds and push_creds.get("username") and not username:
            username = push_creds["username"]

    def run_remote(*args):
        """Run git command that hits the remote, injecting credentials if available."""
        if push_creds and provider != "codecommit":
            return git_with_credentials(list(args), push_creds)
        return run_git(" ".join(args))

    # Check for changes
    code, out, _ = run_git("status --porcelain")
    if not out:
        print("No changes to commit")
        sys.exit(0)

    # Run validation
    if not skip_validation:
        print("Running pre-commit validation...")
        result = subprocess.run([sys.executable, str(SCRIPT_DIR / "pre-commit-validate.py")])
        if result.returncode != 0:
            print("\n❌ Validation failed - commit blocked")
            print("Fix issues or use --skip-validation to bypass (not recommended)")
            sys.exit(1)
        print()

    # Auto-generate defaults (no prompts)
    if not commit_msg:
        commit_msg = f"Update: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
    if not mr_title:
        mr_title = commit_msg
    if not mr_desc:
        mr_desc = f"Changes from {branch_name} branch"

    print(f"Branch: {branch_name}")
    print(f"Commit message: {commit_msg}")
    pr_label = "PR" if provider in ("github", "codecommit") else "MR"
    print(f"{pr_label} title: {mr_title}")
    print(f"{pr_label} description: {mr_desc}\n")

    # Get current branch
    code, current_branch, _ = run_git("rev-parse --abbrev-ref HEAD")
    print(f"Current branch: {current_branch}")

    # Switch to dev branch if not already on it
    if current_branch != branch_name:
        code, _, _ = run_git(f"show-ref --verify --quiet refs/heads/{branch_name}")
        if code == 0:
            print(f"Switching to existing branch: {branch_name}")
            run_git(f"checkout {branch_name}")
        else:
            print(f"Creating new branch: {branch_name} from {default_branch}")
            run_git(f"checkout {default_branch}")
            run_remote("pull", remote, default_branch)
            run_git(f"checkout -b {branch_name}")

    # Stage changes
    print("Staging changes...")
    run_git("add -A")

    # Commit
    print("Committing...")
    code, out, err = run_git(f'commit -m "{commit_msg}"')
    if code != 0 and "nothing to commit" in (out + err):
        print("Nothing to commit (already committed)")

    # Collect SSDF evidence (incremental, advisory)
    evidence_script = Path(__file__).parent.parent.parent / "ssdf-development" / "scripts" / "collect_evidence.py"
    if evidence_script.exists():
        result = subprocess.run(
            [sys.executable, str(evidence_script), "--summary",
             "--output", "docs/compliance-by-family/EVIDENCE-REPORT.md"],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            summary = result.stderr.strip()
            if summary:
                print(summary)
            run_git("add docs/compliance-by-family/EVIDENCE-REPORT.md")
            run_git("commit --amend --no-edit")
        else:
            print("⚠️  Evidence collection skipped (non-blocking)")

    # Push using credential helper (tokens never in URLs)
    print("Pushing to remote...")
    code, out, err = run_remote("push", "-u", remote, branch_name)
    if code != 0 and not push_creds and provider != "codecommit":
        print(f"❌ Push failed — no credentials configured for {base_url or remote}\n")
        print(f"  Quick setup:  python3 {SCRIPT_DIR}/manage-credentials.py setup")
        print(f"  Manual:       python3 {SCRIPT_DIR}/manage-credentials.py set {base_url or remote} --username <user> --token <token>")
        print(f"  Config:       .kiro/config/project.yaml → git-remote.credentials")
        sys.exit(1)
    print(out or err)

    # Create MR/PR based on provider
    print(f"Creating {pr_label.lower()}...")

    if provider == "codecommit":
        repo_name = provider_meta.get("repo_name")
        profile = provider_meta.get("profile")
        if not repo_name:
            print(f"⚠️  Could not determine CodeCommit repo name from remote URL")
            print(f"  Create PR manually: aws codecommit create-pull-request --title \"{mr_title}\" ...")
        else:
            ok, result = create_codecommit_pr(
                repo_name, branch_name, default_branch, mr_title, mr_desc, profile
            )
            if ok:
                pr_id = result
                print(f"✅ Pull request #{pr_id} created" if pr_id else "✅ Pull request created")
                # Auto-merge if no branch protection
                if pr_id and not codecommit_has_branch_protection(repo_name, profile):
                    # Get source commit for merge
                    code, source_commit, _ = run_git("rev-parse HEAD")
                    if code == 0:
                        print("No branch protection detected — auto-merging...")
                        merge_ok, merge_err = merge_codecommit_pr(
                            repo_name, pr_id, source_commit, profile
                        )
                        if merge_ok:
                            print(f"✅ PR #{pr_id} merged to {default_branch}")
                        else:
                            print(f"⚠️  Auto-merge failed: {merge_err}")
                            print(f"  Merge manually in CodeCommit console")
            else:
                print(f"⚠️  PR creation failed: {result}")
                print(f"  Create manually: aws codecommit create-pull-request --title \"{mr_title}\" "
                      f"--targets repositoryName={repo_name},sourceReference={branch_name},"
                      f"destinationReference={default_branch}"
                      + (f" --profile {profile}" if profile else ""))

    elif provider == "gitlab":
        # GitLab MR via push options — push already done above, create MR with a second push
        if push_creds:
            helper = f"!f() {{ echo username={push_creds['username']}; echo password={push_creds['token']}; }}; f"
            code, out, err = run_git(
                f'-c credential.helper=\'{helper}\' push '
                f'-o merge_request.create '
                f'-o merge_request.target={default_branch} '
                f'-o merge_request.title="{mr_title}" '
                f'-o merge_request.description="{mr_desc}" '
                f'-o merge_request.remove_source_branch '
                f'{remote} {branch_name}'
            )
            print(mask_tokens(out or err, creds_all))
        else:
            ok, result = create_gitlab_mr(remote, branch_name, default_branch, mr_title, mr_desc)
            print(result)

    elif provider == "github":
        # GitHub CLI (gh) if available
        gh_check = subprocess.run(["gh", "--version"], capture_output=True, text=True)
        if gh_check.returncode == 0:
            gh_result = subprocess.run(
                ["gh", "pr", "create", "--title", mr_title, "--body", mr_desc,
                 "--base", default_branch, "--head", branch_name],
                capture_output=True, text=True
            )
            print(gh_result.stdout or gh_result.stderr)
        else:
            print("⚠️  GitHub CLI (gh) not installed. Create PR manually at the repo URL.")

    else:
        print(f"⚠️  Unknown provider — cannot auto-create {pr_label}.")
        print(f"  Push succeeded. Create {pr_label} manually in your git provider's UI.")

    print(f"\n✅ Complete!")
    print(f"  Provider: {provider}")
    print(f"  Branch: {branch_name}")
    print(f"  Pushed to: {remote}/{branch_name}")
    print(f"  {pr_label}: {branch_name} → {default_branch}")

if __name__ == "__main__":
    main()
