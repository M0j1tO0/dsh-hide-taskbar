#Requires -Version 5.1
<#
    dsh-plugin-taskbar-autohide -- Windows taskbar helper.

    Spawned and supervised by the host plugin (lib/index.js). Runs as a long-lived
    child process: while a DSH window is in the foreground the Windows taskbar is
    switched to auto-hide; when DSH loses focus the taskbar returns to the baseline
    state (default: always visible).

    Stability design (every point here is a fix for the earlier
    "scheduled task + hidden polling powershell" attempt):
      * SetWinEventHook(EVENT_SYSTEM_FOREGROUND / MINIMIZE*) -- one decision per real
        focus change instead of a 700 ms sample, so a switch can never be missed.
      * Every decision re-reads the REAL registry state first -- no reliance on an
        in-process "$current" guess, so external changes (explorer restart, the user
        toggling the setting by hand) are corrected automatically.
      * Periodic resync as a backstop -- even if every event were lost, the correct
        state is restored within ResyncMs.
      * Parent liveness check -- if the host dies unexpectedly the helper exits and
        restores the taskbar itself, so it can never leave the desktop in a
        "taskbar permanently hidden" state.
      * Single-instance mutex -- during an HMR reload the old and new helper do not
        fight each other.
      * Heartbeats on stdout -- the plugin detects a hung helper and restarts it.

    -DryRun prints decisions without touching the registry (diagnostics).

    NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 decodes a
    BOM-less file as ANSI, so non-ASCII characters (including inside the embedded
    C# below) get corrupted and break compilation.
#>
[CmdletBinding()]
param(
    [int]$ParentPid = 0,
    [string]$StateFile = '',
    [string]$LogFile = '',
    [string]$ProcessNames = 'DeepSeek Harness',
    [int]$ResyncMs = 2000,
    [int]$HeartbeatMs = 5000,
    [string]$MutexName = 'Local\DshTaskbarAutohide',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$csharp = @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

public static class DshTaskbarWatch
{
    private const string RegPath = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3";
    private const string RegValue = "Settings";

    private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    private const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016;
    private const uint EVENT_SYSTEM_MINIMIZEEND = 0x0017;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    private const uint PM_REMOVE = 0x0001;

    private const uint ABM_SETSTATE = 0x0000000A;
    private const int ABS_AUTOHIDE = 0x1;
    private const int ABS_ALWAYSONTOP = 0x2;

    private delegate void WinEventDelegate(IntPtr hHook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
        public uint time; public int ptX; public int ptY;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct APPBARDATA
    {
        public int cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge;
        public RECT rc; public int lParam;
    }

    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventDelegate cb, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out MSG msg, IntPtr hWnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("shell32.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint SHAppBarMessage(uint msg, ref APPBARDATA data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string cls, string win);

    private static WinEventDelegate _cb;
    private static IntPtr _hook = IntPtr.Zero;
    private static volatile bool _stop;
    private static volatile bool _dirty;
    private static volatile bool _stopped;

    private static string _stateFile = "";
    private static string _logFile = "";
    private static int _parentPid;
    private static int _resyncMs = 2000;
    private static int _heartbeatMs = 5000;
    private static bool _dryRun;

    private static bool _enabled = true;
    private static volatile bool _shutdown;
    private static int _baseline;                 // 0 = always visible, 1 = auto-hide
    private static string[] _names = new string[] { "DeepSeek Harness" };
    private static DateTime _stateStamp = DateTime.MinValue;
    private static DateTime _lastHeartbeat = DateTime.MinValue;
    private static int _applied = -1;
    private static int _lastDryWant = -1;
    private static Mutex _mutex;
    private static readonly object _io = new object();

    public static int Run(int parentPid, string processNamesCsv, string stateFile, string logFile, int resyncMs, int heartbeatMs, string mutexName, bool dryRun)
    {
        _parentPid = parentPid;
        _stateFile = stateFile == null ? "" : stateFile;
        _logFile = logFile == null ? "" : logFile;
        _resyncMs = resyncMs < 200 ? 200 : resyncMs;
        _heartbeatMs = heartbeatMs < 500 ? 500 : heartbeatMs;
        _dryRun = dryRun;
        _names = SplitNames(processNamesCsv);

        bool createdNew;
        string mutex = (mutexName == null || mutexName.Trim().Length == 0) ? @"Local\DshTaskbarAutohide" : mutexName.Trim();
        _mutex = new Mutex(true, mutex, out createdNew);
        if (!createdNew)
        {
            bool got = false;
            for (int i = 0; i < 30 && !got; i++)
            {
                Thread.Sleep(100);
                try { got = _mutex.WaitOne(0); }
                catch (AbandonedMutexException) { got = true; }
            }
            if (!got)
            {
                Log("another helper instance is running; this one exits");
                Emit("{\"type\":\"duplicate\"}");
                return 2;
            }
        }

        Log("helper start: pid=" + Process.GetCurrentProcess().Id + " parent=" + _parentPid
            + " dryRun=" + (dryRun ? "true" : "false") + " names=[" + string.Join(",", _names) + "]"
            + " stateFile=" + _stateFile);
        Emit("{\"type\":\"start\",\"pid\":" + Process.GetCurrentProcess().Id + ",\"dryRun\":" + (dryRun ? "true" : "false") + "}");

        ReadState(true);

        _cb = new WinEventDelegate(OnWinEvent);
        _hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, _cb, 0, 0,
                                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        if (_hook == IntPtr.Zero)
            Log("WARN SetWinEventHook failed; falling back to " + _resyncMs + "ms polling");

        Console.CancelKeyPress += OnCancelKey;
        AppDomain.CurrentDomain.ProcessExit += OnProcessExit;

        Tick(true);
        _lastHeartbeat = DateTime.UtcNow;
        EmitHeartbeat();

        DateTime nextTick = DateTime.UtcNow.AddMilliseconds(_resyncMs);
        DateTime nextBeat = DateTime.UtcNow.AddMilliseconds(_heartbeatMs);
        MSG msg;
        while (!_stop)
        {
            while (PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE))
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }

            bool dirty = _dirty;
            _dirty = false;
            if (dirty || DateTime.UtcNow >= nextTick)
            {
                nextTick = DateTime.UtcNow.AddMilliseconds(_resyncMs);
                if (!Tick(false)) break;
            }

            if (DateTime.UtcNow >= nextBeat)
            {
                nextBeat = DateTime.UtcNow.AddMilliseconds(_heartbeatMs);
                _lastHeartbeat = DateTime.UtcNow;
                EmitHeartbeat();
            }

            Thread.Sleep(80);
        }

        Shutdown();
        return 0;
    }

    private static void OnWinEvent(IntPtr hHook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        _dirty = true;
    }

    private static void OnCancelKey(object sender, ConsoleCancelEventArgs e)
    {
        e.Cancel = true;
        _stop = true;
    }

    private static void OnProcessExit(object sender, EventArgs e)
    {
        Shutdown();
    }

    /// <summary>One full decision: read the real state, decide the target, write only if needed.</summary>
    private static bool Tick(bool force)
    {
        ReadState(force);

        if (_shutdown)
        {
            Log("shutdown requested by host; restoring and exiting");
            return false;
        }

        if (_parentPid > 0 && !ProcessExists(_parentPid))
        {
            Log("parent pid " + _parentPid + " is gone; exiting");
            return false;
        }

        int want = _baseline;
        bool focused = false;
        if (_enabled)
        {
            focused = IsDshForeground();
            if (focused) want = 1;
        }

        if (_dryRun)
        {
            if (want != _lastDryWant)
            {
                _lastDryWant = want;
                Log("dryRun decision: auto-hide=" + want + " (dshForeground=" + (focused ? "yes" : "no") + ")");
                Emit("{\"type\":\"decision\",\"hide\":" + want + ",\"focused\":" + (focused ? "true" : "false") + "}");
            }
            return true;
        }

        int actual = ReadCurrent();
        if (actual == want)
        {
            _applied = want;
            return true;
        }

        Apply(want, actual, focused);
        return true;
    }

    private static void Apply(int want, int actual, bool focused)
    {
        if (!WriteCurrent(want))
        {
            Log("WARN registry write failed; cannot switch taskbar (actual=" + actual + " want=" + want + ")");
            Emit("{\"type\":\"error\",\"message\":\"registry write failed\"}");
            return;
        }

        Nudge(want);
        _applied = want;
        Log("auto-hide " + (want == 1 ? "ON" : "OFF") + " (dshForeground=" + (focused ? "yes" : "no") + ", was=" + actual + ")");
        Emit("{\"type\":\"state\",\"hide\":" + want + ",\"was\":" + actual + ",\"focused\":" + (focused ? "true" : "false") + "}");
    }

    private static bool IsDshForeground()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return false;
        if (IsIconic(hwnd)) return false;

        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0) return false;

        try
        {
            string name = Process.GetProcessById((int)pid).ProcessName;
            for (int i = 0; i < _names.Length; i++)
            {
                if (string.Equals(_names[i], name, StringComparison.OrdinalIgnoreCase)) return true;
            }
        }
        catch { }
        return false;
    }

    private static bool ProcessExists(int pid)
    {
        try { Process p = Process.GetProcessById(pid); return p != null && !p.HasExited; }
        catch { return false; }
    }

    private static int ReadCurrent()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RegPath, false))
            {
                if (k == null) return -1;
                byte[] b = k.GetValue(RegValue) as byte[];
                if (b == null || b.Length < 9) return -1;
                return (b[8] & 0x01) != 0 ? 1 : 0;
            }
        }
        catch { return -1; }
    }

    private static bool WriteCurrent(int want)
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RegPath, true))
            {
                if (k == null) return false;
                byte[] b = k.GetValue(RegValue) as byte[];
                if (b == null || b.Length < 9) return false;
                byte[] copy = (byte[])b.Clone();
                if (want == 1) copy[8] = (byte)(copy[8] | 0x01);
                else copy[8] = (byte)(copy[8] & 0xFE);
                k.SetValue(RegValue, copy, RegistryValueKind.Binary);
                return true;
            }
        }
        catch (Exception ex)
        {
            Log("WARN registry write exception: " + ex.Message);
            return false;
        }
    }

    /// <summary>Some systems need the appbar message too; send the combination that was verified to work.</summary>
    private static void Nudge(int want)
    {
        try
        {
            IntPtr tray = FindWindow("Shell_TrayWnd", null);
            if (tray == IntPtr.Zero) return;
            APPBARDATA d = new APPBARDATA();
            d.cbSize = Marshal.SizeOf(typeof(APPBARDATA));
            d.hWnd = tray;
            d.lParam = want == 1 ? ABS_AUTOHIDE : ABS_ALWAYSONTOP;
            SHAppBarMessage(ABM_SETSTATE, ref d);
        }
        catch { }
    }

    /// <summary>Read the state file (enabled / baseline / names / shutdown); skip when mtime is unchanged.</summary>
    private static void ReadState(bool force)
    {
        if (_stateFile.Length == 0) return;
        try
        {
            FileInfo fi = new FileInfo(_stateFile);
            if (!fi.Exists) return;
            if (!force && fi.LastWriteTimeUtc == _stateStamp) return;
            _stateStamp = fi.LastWriteTimeUtc;

            string[] lines;
            using (FileStream fs = new FileStream(_stateFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (StreamReader sr = new StreamReader(fs, Encoding.UTF8))
            {
                lines = sr.ReadToEnd().Split('\n');
            }

            string namesCsv = null;
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq).Trim().ToLowerInvariant();
                string val = line.Substring(eq + 1).Trim();
                if (key == "enabled") _enabled = val == "1" || val.Equals("true", StringComparison.OrdinalIgnoreCase);
                else if (key == "shutdown") _shutdown = val == "1" || val.Equals("true", StringComparison.OrdinalIgnoreCase);
                else if (key == "baseline") _baseline = (val == "1" || val.Equals("autohide", StringComparison.OrdinalIgnoreCase)) ? 1 : 0;
                else if (key == "names") namesCsv = val;
            }
            if (namesCsv != null)
            {
                string[] next = SplitNames(namesCsv);
                if (next.Length > 0) _names = next;
            }
        }
        catch (Exception ex)
        {
            Log("WARN cannot read state file: " + ex.Message);
        }
    }

    private static string[] SplitNames(string csv)
    {
        if (csv == null || csv.Trim().Length == 0) return new string[] { "DeepSeek Harness" };
        string[] raw = csv.Split(',');
        System.Collections.Generic.List<string> outList = new System.Collections.Generic.List<string>();
        for (int i = 0; i < raw.Length; i++)
        {
            string s = raw[i].Trim();
            if (s.Length > 0) outList.Add(s);
        }
        return outList.Count > 0 ? outList.ToArray() : new string[] { "DeepSeek Harness" };
    }

    private static void EmitHeartbeat()
    {
        Emit("{\"type\":\"heartbeat\",\"ts\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}");
    }

    private static void Emit(string json)
    {
        try
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
        catch { }
    }

    private static void Log(string message)
    {
        string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "  " + message;
        lock (_io)
        {
            try
            {
                if (_logFile.Length > 0)
                {
                    FileInfo fi = new FileInfo(_logFile);
                    if (fi.Exists && fi.Length > 262144)
                    {
                        try { File.Delete(_logFile); } catch { }
                    }
                    File.AppendAllText(_logFile, line + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch { }
        }
    }

    private static void Shutdown()
    {
        if (_stopped) return;
        _stopped = true;
        _stop = true;
        try { if (_hook != IntPtr.Zero) UnhookWinEvent(_hook); } catch { }
        try
        {
            // dryRun must be side-effect free on every path, including shutdown.
            if (!_dryRun)
            {
                int actual = ReadCurrent();
                if (actual != _baseline) Apply(_baseline, actual, false);
            }
            Log("helper stop: baseline auto-hide=" + _baseline + (_dryRun ? " (dryRun: nothing written)" : ""));
            Emit("{\"type\":\"bye\"}");
        }
        catch { }
        try { if (_mutex != null) _mutex.ReleaseMutex(); } catch { }
    }
}
'@

Add-Type -TypeDefinition $csharp -Language CSharp

exit [DshTaskbarWatch]::Run($ParentPid, $ProcessNames, $StateFile, $LogFile, $ResyncMs, $HeartbeatMs, $MutexName, [bool]$DryRun)
