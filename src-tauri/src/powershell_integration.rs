pub const POWERSHELL_COMPLETION_INTEGRATION_ENV: &str =
    "TERMFLOW_POWERSHELL_COMPLETION_INTEGRATION";

pub const POWERSHELL_COMPLETION_INTEGRATION_COMMAND: &str =
    "if ($env:TERMFLOW_POWERSHELL_COMPLETION_INTEGRATION) { . ([scriptblock]::Create($env:TERMFLOW_POWERSHELL_COMPLETION_INTEGRATION)) }";

/// Loaded only for Termflow's native PowerShell terminal sessions. The script
/// emits OSC 133 lifecycle markers while preserving the user's existing prompt
/// script block and profile. PSReadLine owns the editable input line, so it is
/// the only reliable point at which to emit the command-start marker.
pub const POWERSHELL_COMPLETION_INTEGRATION_SCRIPT: &str = r#"
if (-not $global:__termflowCompletionIntegrationLoaded) {
  $global:__termflowCompletionIntegrationLoaded = $true
  $global:__termflowCompletionEsc = [char]27
  $global:__termflowCompletionBel = [char]7
  $global:__termflowCompletionRunning = $false
  $global:__termflowCompletionCanTrackCommands = $false
  $global:__termflowLastExitCodeBeforeCommand = $null
  $global:__termflowOriginalPrompt = (Get-Command prompt -CommandType Function -ErrorAction SilentlyContinue).ScriptBlock

  function global:Write-TermflowCompletionMarker([string]$Marker) {
    [Console]::Out.Write("$global:__termflowCompletionEsc]133;$Marker$global:__termflowCompletionBel")
  }

  function global:prompt {
    $termflowSucceeded = $?
    $termflowLastExitCode = $global:LASTEXITCODE
    if ($global:__termflowCompletionRunning) {
      $global:__termflowCompletionRunning = $false
      $termflowExitCode = if ($termflowSucceeded) {
        0
      } elseif (
        $termflowLastExitCode -is [int] -and
        $termflowLastExitCode -ne $global:__termflowLastExitCodeBeforeCommand
      ) {
        $termflowLastExitCode
      } else {
        ""
      }
      Write-TermflowCompletionMarker "D;$termflowExitCode"
    }

    $termflowCommandLifecycle = if ($global:__termflowCompletionCanTrackCommands) { "enabled" } else { "disabled" }
    Write-TermflowCompletionMarker "A;termflow=1;command-lifecycle=$termflowCommandLifecycle"
    if ($null -ne $global:__termflowOriginalPrompt) {
      & $global:__termflowOriginalPrompt
    } else {
      "PS $($executionContext.SessionState.Path.CurrentLocation)> "
    }
    Write-TermflowCompletionMarker "B"
  }

  try {
    if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {
      $termflowEnterHandler = Get-PSReadLineKeyHandler -Bound |
        Where-Object { $_.Key -eq "Enter" } |
        Select-Object -First 1
      if ($null -eq $termflowEnterHandler -or $termflowEnterHandler.Function -eq "AcceptLine") {
        Set-PSReadLineKeyHandler -Key Enter -BriefDescription "TermflowAcceptLine" -ScriptBlock {
          [string]$termflowLine = ""
          [int]$termflowCursor = 0
          [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$termflowLine, [ref]$termflowCursor)
          if (-not [string]::IsNullOrWhiteSpace($termflowLine)) {
            $global:__termflowLastExitCodeBeforeCommand = $global:LASTEXITCODE
            Write-TermflowCompletionMarker "C"
            $global:__termflowCompletionRunning = $true
          }
          [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        }
        $global:__termflowCompletionCanTrackCommands = $true
      }
    }
  } catch {
    # Without PSReadLine no reliable command-start hook is available. Prompt
    # markers still identify the integration, while the frontend declines to
    # infer a completion without a matching C marker.
  }
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integration_preserves_the_prompt_and_emits_explicit_lifecycle_markers() {
        assert!(POWERSHELL_COMPLETION_INTEGRATION_SCRIPT.contains("__termflowOriginalPrompt"));
        assert!(POWERSHELL_COMPLETION_INTEGRATION_SCRIPT.contains("\"C\""));
        assert!(POWERSHELL_COMPLETION_INTEGRATION_SCRIPT.contains("\"D;$termflowExitCode\""));
        assert!(POWERSHELL_COMPLETION_INTEGRATION_SCRIPT.contains("Set-PSReadLineKeyHandler"));
        assert!(POWERSHELL_COMPLETION_INTEGRATION_SCRIPT.contains("$termflowSucceeded = $?"));
        assert!(POWERSHELL_COMPLETION_INTEGRATION_SCRIPT
            .contains("$global:__termflowCompletionRunning"));
        assert!(POWERSHELL_COMPLETION_INTEGRATION_SCRIPT
            .contains("command-lifecycle=$termflowCommandLifecycle"));
        assert!(POWERSHELL_COMPLETION_INTEGRATION_SCRIPT
            .contains("$termflowEnterHandler.Function -eq \"AcceptLine\""));
        assert!(POWERSHELL_COMPLETION_INTEGRATION_SCRIPT
            .contains("__termflowLastExitCodeBeforeCommand"));
    }
}
