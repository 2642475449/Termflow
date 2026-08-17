; Termflow NSIS installer hooks.
; Register classic Explorer verbs for the current user only. HKCU\Software\Classes
; is merged into HKCR by Explorer without requiring administrator privileges.

!define TERMFLOW_FOLDER_MENU_KEY "Software\Classes\Directory\shell\Termflow.OpenFolder"
!define TERMFLOW_FOLDER_COMMAND_KEY "${TERMFLOW_FOLDER_MENU_KEY}\command"
!define TERMFLOW_BACKGROUND_MENU_KEY "Software\Classes\Directory\Background\shell\Termflow.OpenFolder"
!define TERMFLOW_BACKGROUND_COMMAND_KEY "${TERMFLOW_BACKGROUND_MENU_KEY}\command"
!define TERMFLOW_PREFERENCES_KEY "Software\Termflow"
!define TERMFLOW_CONTEXT_MENU_ENABLED_VALUE "ExplorerContextMenuEnabled"
!define TERMFLOW_OWNER_VALUE_NAME "TermflowOwner"
!define TERMFLOW_OWNER_MARKER "com.termflow.desktop"

; Newer verbs carry a stable owner marker, which lets an upgrade or uninstall
; clean an entry created at an older executable path. For legacy marker-less
; entries, retain the exact current-install command check as a safe fallback.
!macro TERMFLOW_REMOVE_OWNED_CONTEXT_MENUS
  ReadRegStr $0 HKCU "${TERMFLOW_FOLDER_MENU_KEY}" "${TERMFLOW_OWNER_VALUE_NAME}"
  ${If} $0 == "${TERMFLOW_OWNER_MARKER}"
    DeleteRegKey HKCU "${TERMFLOW_FOLDER_MENU_KEY}"
  ${ElseIf} $0 == ""
    ReadRegStr $0 HKCU "${TERMFLOW_FOLDER_COMMAND_KEY}" ""
    ${If} $0 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey HKCU "${TERMFLOW_FOLDER_MENU_KEY}"
    ${EndIf}
  ${EndIf}

  ReadRegStr $0 HKCU "${TERMFLOW_BACKGROUND_MENU_KEY}" "${TERMFLOW_OWNER_VALUE_NAME}"
  ${If} $0 == "${TERMFLOW_OWNER_MARKER}"
    DeleteRegKey HKCU "${TERMFLOW_BACKGROUND_MENU_KEY}"
  ${ElseIf} $0 == ""
    ReadRegStr $0 HKCU "${TERMFLOW_BACKGROUND_COMMAND_KEY}" ""
    ${If} $0 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%V$\""
      DeleteRegKey HKCU "${TERMFLOW_BACKGROUND_MENU_KEY}"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Settings writes this sentinel before changing the verbs. Respect a prior
  ; opt-out even when an update/reinstall finishes before Termflow starts.
  ReadRegStr $0 HKCU "${TERMFLOW_PREFERENCES_KEY}" "${TERMFLOW_CONTEXT_MENU_ENABLED_VALUE}"
  ${If} $0 == "0"
    ; Clean entries we can prove Termflow owns, but never claim a foreign verb.
    !insertmacro TERMFLOW_REMOVE_OWNED_CONTEXT_MENUS
  ${Else}
    ; The selected folder uses %1. The background verb uses %V, which resolves
    ; to the folder whose empty area the user clicked.
    WriteRegStr HKCU "${TERMFLOW_FOLDER_MENU_KEY}" "" "Open with Termflow"
    WriteRegStr HKCU "${TERMFLOW_FOLDER_MENU_KEY}" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr HKCU "${TERMFLOW_FOLDER_MENU_KEY}" "${TERMFLOW_OWNER_VALUE_NAME}" "${TERMFLOW_OWNER_MARKER}"
    WriteRegStr HKCU "${TERMFLOW_FOLDER_COMMAND_KEY}" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

    WriteRegStr HKCU "${TERMFLOW_BACKGROUND_MENU_KEY}" "" "Open with Termflow"
    WriteRegStr HKCU "${TERMFLOW_BACKGROUND_MENU_KEY}" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr HKCU "${TERMFLOW_BACKGROUND_MENU_KEY}" "${TERMFLOW_OWNER_VALUE_NAME}" "${TERMFLOW_OWNER_MARKER}"
    WriteRegStr HKCU "${TERMFLOW_BACKGROUND_COMMAND_KEY}" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%V$\""

    ; First-time installs default to enabled; keep an existing "1" unchanged.
    WriteRegStr HKCU "${TERMFLOW_PREFERENCES_KEY}" "${TERMFLOW_CONTEXT_MENU_ENABLED_VALUE}" "1"
  ${EndIf}

  ; Tell Explorer to refresh its class association cache without requiring a
  ; restart. SHCNE_ASSOCCHANGED = 0x08000000, SHCNF_IDLIST = 0.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro TERMFLOW_REMOVE_OWNED_CONTEXT_MENUS

  ; Keep the per-user sentinel. Tauri's update path runs this uninstaller with
  ; /UPDATE, and retaining the opt-out also makes a later reinstall honour it.

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
