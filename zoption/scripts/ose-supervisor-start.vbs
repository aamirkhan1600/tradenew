' Launch the OSE supervisor with no console window.
'
' A shortcut to this lives in the Startup folder, so the engine comes back after
' a reboot or a logout without anyone typing anything. The supervisor itself is
' scripts\ose-supervisor.ps1 — this file exists only because
' `powershell -WindowStyle Hidden` still flashes a console for a moment, and a
' window that appears on every login is a window somebody eventually closes.
'
' Remove the Startup shortcut to stop auto-starting; nothing else depends on it.
Dim shell, here
Set shell = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & here & "\ose-supervisor.ps1"" -Loop", 0, False
