; AGENTS.md 要躺在安装目录根上，和 fb.exe 一起。
; bundle.resources 在有的布局里会进 resources\ 子目录，这里再补一次。

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\AGENTS.md" agents_md_done
  IfFileExists "$INSTDIR\resources\AGENTS.md" 0 agents_md_done
  CopyFiles /SILENT "$INSTDIR\resources\AGENTS.md" "$INSTDIR\AGENTS.md"
  agents_md_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\AGENTS.md"
!macroend
