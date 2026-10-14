' Silent helper: run Control UI with no console window.
' Desktop / repo shortcuts should target this .vbs (or the .bat wrapper).
Option Explicit
Dim sh, fso, root, ps1, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = root & "\OpenClaw-Control-UI.ps1"
If Not fso.FileExists(ps1) Then
  sh.Popup "Missing OpenClaw-Control-UI.ps1 next to:" & vbCrLf & root, 0, "OpenClaw Control UI", 16
  WScript.Quit 1
End If
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
sh.Run cmd, 0, False
