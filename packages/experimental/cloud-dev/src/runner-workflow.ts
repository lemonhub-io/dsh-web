/** The GitHub Actions workflow that runs cloud development jobs in the runner repository. */

/** Path of the runner workflow inside the runner repository. */
export const RUNNER_WORKFLOW_PATH = '.github/workflows/dsh-cloud-run.yml'

/** Artifact name holding the log, exit status and returned files of one job. */
export const RESULT_ARTIFACT = 'dsh-cloud-result'

/**
 * Inputs reach the shell only through environment variables, never through expression
 * interpolation inside a script, so a command cannot rewrite the workflow.
 */
export const RUNNER_WORKFLOW = `# Installed by the DSH cloud development plugin.
# Each job arrives as a commit on dsh-cloud/<job> with the workspace snapshot under workspace/.
name: DSH Cloud Run
run-name: dsh-cloud \${{ inputs.job }}

on:
  workflow_dispatch:
    inputs:
      job:
        description: Job id
        required: true
        type: string
      command:
        description: Shell command run inside the snapshot
        required: true
        type: string
      workdir:
        description: Directory inside the snapshot
        required: false
        type: string
        default: .
      outputs:
        description: Newline-separated globs returned with the result
        required: false
        type: string
        default: ''

permissions:
  contents: read

jobs:
  run:
    name: Run
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - name: Run command
        shell: bash
        env:
          DSH_COMMAND: \${{ inputs.command }}
          DSH_WORKDIR: \${{ inputs.workdir }}
        run: |
          result="$GITHUB_WORKSPACE/.dsh-cloud"
          mkdir -p "$result/files"
          case "$DSH_WORKDIR" in /*|..|../*|*/../*|*/..) echo "invalid workdir" > "$result/output.log"; echo 2 > "$result/exit-code"; exit 0;; esac
          cd "$GITHUB_WORKSPACE/workspace/$DSH_WORKDIR"
          start=$(date +%s)
          set +e
          bash -c "$DSH_COMMAND" 2>&1 | tee "$result/output.log"
          code=\${PIPESTATUS[0]}
          set -e
          echo "$code" > "$result/exit-code"
          echo "$(( $(date +%s) - start ))" > "$result/duration-seconds"
      - name: Collect outputs
        if: always()
        shell: bash
        env:
          DSH_OUTPUTS: \${{ inputs.outputs }}
          DSH_WORKDIR: \${{ inputs.workdir }}
        run: |
          result="$GITHUB_WORKSPACE/.dsh-cloud"
          mkdir -p "$result/files"
          cd "$GITHUB_WORKSPACE/workspace/$DSH_WORKDIR" 2>/dev/null || exit 0
          shopt -s globstar nullglob dotglob
          while IFS= read -r pattern; do
            [ -z "$pattern" ] && continue
            for file in $pattern; do
              case "$file" in /*|..|../*|*/../*) continue;; esac
              [ -f "$file" ] || continue
              mkdir -p "$result/files/$(dirname "$file")"
              cp "$file" "$result/files/$file"
            done
          done <<< "$DSH_OUTPUTS"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ${RESULT_ARTIFACT}
          path: .dsh-cloud
          include-hidden-files: true
          retention-days: 3
      - name: Report exit status
        shell: bash
        run: exit "$(cat .dsh-cloud/exit-code 2>/dev/null || echo 1)"
`
