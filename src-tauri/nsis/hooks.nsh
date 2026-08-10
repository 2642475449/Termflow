; Termflow NSIS Installer Hooks
; 注册文件夹右键菜单"用 Termflow 打开"

!macro NSIS_HOOK_POSTINSTALL
  ; 注册文件夹右键菜单
  WriteRegStr HKCU "Directory\shell\Termflow" "" "用 Termflow 打开"
  WriteRegStr HKCU "Directory\shell\Termflow" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr HKCU "Directory\shell\Termflow\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  ; 注册文件夹背景右键菜单（在文件夹空白处右键）
  WriteRegStr HKCU "Directory\Background\shell\Termflow" "" "用 Termflow 打开"
  WriteRegStr HKCU "Directory\Background\shell\Termflow" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr HKCU "Directory\Background\shell\Termflow\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%V$\""
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 移除文件夹右键菜单
  DeleteRegKey HKCU "Directory\shell\Termflow"
  DeleteRegKey HKCU "Directory\Background\shell\Termflow"

  ; 注意：不要删除应用数据目录，保留用户的设置和数据
  ; 数据目录位于 %LOCALAPPDATA%\com.termflow.desktop\
  ; 如果用户需要完全清除数据，可以手动删除该目录
!macroend
