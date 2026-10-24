; MeshLink installer additions (included by electron-builder's NSIS script).

; Uninstall: your account key, contacts and messages live in %APPDATA%\MeshLink.
; Keep them by default, so a reinstall or update finds them again. Ask once,
; and never during an update (electron-builder runs the old uninstaller then).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Also delete your MeshLink account, contacts and messages from this PC?$\r$\n$\r$\nChoose No to keep them, for example to reinstall later.$\r$\nWithout a backup or your recovery phrase, deleted keys cannot be recovered." \
      /SD IDNO IDNO meshlink_keep_data
      SetShellVarContext current
      RMDir /r "$APPDATA\MeshLink"
    meshlink_keep_data:
  ${endIf}
!macroend
