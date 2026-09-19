using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// 只读 Windows 前台窗口和任务栏的几何信息，不改变系统任务栏或游戏窗口。
internal static class DesktopState
{
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    delegate bool EnumWindowProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowProc callback, IntPtr param);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attr, out Rect value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetWindowAttributeUint(IntPtr hwnd, uint attr, out uint value, int size);

    static bool Visible(IntPtr hwnd)
    {
        uint cloaked;
        return IsWindowVisible(hwnd) && !IsIconic(hwnd) &&
            (DwmGetWindowAttributeUint(hwnd, 14, out cloaked, 4) != 0 || cloaked == 0);
    }

    static string Snapshot(int parent)
    {
        IntPtr foreground = GetForegroundWindow();
        uint pid;
        GetWindowThreadProcessId(foreground, out pid);
        if (foreground == IntPtr.Zero || pid == parent || !Visible(foreground)) return "{\"fullscreen\":null}";
        StringBuilder foregroundClass = new StringBuilder(128);
        GetClassName(foreground, foregroundClass, foregroundClass.Capacity);
        if (foregroundClass.ToString() == "Progman" || foregroundClass.ToString() == "WorkerW") return "{\"fullscreen\":null}";
        MonitorInfo info = new MonitorInfo(); info.Size = Marshal.SizeOf(info);
        if (!GetMonitorInfo(MonitorFromWindow(foreground, 2), ref info)) return "{\"fullscreen\":null}";
        Rect rect;
        if (DwmGetWindowAttribute(foreground, 9, out rect, Marshal.SizeOf(typeof(Rect))) != 0 && !GetWindowRect(foreground, out rect)) return "{\"fullscreen\":null}";
        Rect monitor = info.Monitor;
        if (rect.Left > monitor.Left + 1 || rect.Top > monitor.Top + 1 || rect.Right < monitor.Right - 1 || rect.Bottom < monitor.Bottom - 1) return "{\"fullscreen\":null}";
        bool taskbarAbove = false;
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            if (hwnd == foreground) return false;
            if (!Visible(hwnd)) return true;
            StringBuilder name = new StringBuilder(128);
            GetClassName(hwnd, name, name.Capacity);
            if (name.ToString() != "Shell_TrayWnd" && name.ToString() != "Shell_SecondaryTrayWnd") return true;
            Rect bar;
            if (GetWindowRect(hwnd, out bar) && Math.Min(bar.Right, monitor.Right) - Math.Max(bar.Left, monitor.Left) > 2 && Math.Min(bar.Bottom, monitor.Bottom) - Math.Max(bar.Top, monitor.Top) > 2) taskbarAbove = true;
            return !taskbarAbove;
        }, IntPtr.Zero);
        if (taskbarAbove) return "{\"fullscreen\":null}";
        return "{\"fullscreen\":{\"x\":" + monitor.Left + ",\"y\":" + monitor.Top + ",\"width\":" + (monitor.Right - monitor.Left) + ",\"height\":" + (monitor.Bottom - monitor.Top) + "}}";
    }

    public static void Main(string[] args)
    {
        int parent;
        if (args.Length != 1 || !int.TryParse(args[0], out parent)) return;
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        Console.OutputEncoding = new UTF8Encoding(false);
        string previous = null;
        while (true) {
            try { using (Process process = Process.GetProcessById(parent)) { if (process.HasExited) return; } }
            catch { return; }
            string next;
            try { next = Snapshot(parent); }
            catch { next = "{\"fullscreen\":null}"; }
            if (next != previous) { Console.WriteLine(next); Console.Out.Flush(); previous = next; }
            Thread.Sleep(250);
        }
    }
}
