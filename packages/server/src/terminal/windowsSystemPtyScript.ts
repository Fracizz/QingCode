// 内联进 qn-server.cjs，Windows 本机和远端都只需要系统自带的 PowerShell 与 ConPTY。
// i18n-ignore: 下方中文仅用于内联桥接代码的注释。
export const CONPTY_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public sealed class QingCodeConPty {
    [StructLayout(LayoutKind.Sequential)]
    private struct Coord {
        public short Cols, Rows;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XChars, YChars, FillAttribute, Flags;
        public short ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, StandardInput, StandardOutput, StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx {
        public StartupInfo Info;
        public IntPtr Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo {
        public IntPtr Process, Thread;
        public int Pid, Tid;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr security, int size);
    [DllImport("kernel32.dll")]
    private static extern int CreatePseudoConsole(Coord size, SafeFileHandle read, SafeFileHandle write, int flags, out IntPtr conpty);
    [DllImport("kernel32.dll")]
    private static extern int ResizePseudoConsole(IntPtr conpty, Coord size);
    [DllImport("kernel32.dll")]
    private static extern void ClosePseudoConsole(IntPtr conpty);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr attribute, IntPtr value,
        IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr env, string cwd,
        ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out int exitCode);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);

    private readonly object consoleLock = new object();
    private IntPtr conpty;

    public static int Run() {
        return new QingCodeConPty().RunSession();
    }

    private int RunSession() {
        var requests = new BinaryReader(Console.OpenStandardInput());
        Coord size = ReadSize(requests);
        string command = Encoding.UTF8.GetString(requests.ReadBytes(requests.ReadInt32()));
        SafeFileHandle inputRead, inputWrite, outputRead, outputWrite;
        if (!CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0)) throw new Win32Exception();
        using (inputRead)
        using (inputWrite) {
            if (!CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0)) throw new Win32Exception();
            using (outputRead)
            using (outputWrite) {
                Marshal.ThrowExceptionForHR(CreatePseudoConsole(size, inputRead, outputWrite, 0, out conpty));
                inputRead.Dispose();
                outputWrite.Dispose();
                // 旧版 Windows 关闭 ConPTY 时仍可能写出最后一帧，读取线程必须继续排空。
                var output = StartThread(delegate { DrainOutput(outputRead); });
                ProcessInfo process = new ProcessInfo();
                try {
                    Console.Error.WriteLine("conpty");
                    process = StartShell(command);
                    CloseHandle(process.Thread);
                    StartThread(delegate { ForwardInput(requests, inputWrite); });
                    Console.Error.WriteLine("ready " + process.Pid);
                    if (WaitForSingleObject(process.Process, uint.MaxValue) != 0) throw new Win32Exception();
                    int exitCode;
                    if (!GetExitCodeProcess(process.Process, out exitCode)) throw new Win32Exception();
                    return exitCode;
                } finally {
                    CloseConsole();
                    output.Join();
                    if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
                }
            }
        }
    }

    private ProcessInfo StartShell(string command) {
        const int extendedStartupInfoPresent = 0x00080000;
        const int useStdHandles = 0x00000100;
        var bytes = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
        var attributes = Marshal.AllocHGlobal(bytes);
        try {
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes)) throw new Win32Exception();
            try {
                var pseudoConsoleAttribute = new IntPtr(0x00020016);
                if (!UpdateProcThreadAttribute(attributes, 0, pseudoConsoleAttribute, conpty,
                    new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                var startup = new StartupInfoEx();
                startup.Info.Size = Marshal.SizeOf(typeof(StartupInfoEx));
                // 留空标准句柄，让 ConPTY 接管输入输出，避免 shell 继承桥接管道。
                startup.Info.Flags = useStdHandles;
                startup.Attributes = attributes;
                ProcessInfo process;
                // detached daemon 可能继承了忽略 Ctrl+C 的标志，启动 shell 前恢复默认行为。
                SetConsoleCtrlHandler(IntPtr.Zero, false);
                if (!CreateProcessW(null, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false,
                    extendedStartupInfoPresent, IntPtr.Zero, null, ref startup, out process)) throw new Win32Exception();
                return process;
            } finally {
                DeleteProcThreadAttributeList(attributes);
            }
        } finally {
            Marshal.FreeHGlobal(attributes);
        }
    }

    private static Coord ReadSize(BinaryReader requests) {
        return new Coord { Cols = requests.ReadInt16(), Rows = requests.ReadInt16() };
    }

    private static Thread StartThread(ThreadStart body) {
        var thread = new Thread(body);
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    private void ForwardInput(BinaryReader requests, SafeFileHandle handle) {
        try {
            using (var input = new FileStream(handle, FileAccess.Write, 4096, false)) {
                while (true) {
                    int length = requests.ReadInt32();
                    if (length == 0) {
                        Coord size = ReadSize(requests);
                        lock (consoleLock) {
                            if (conpty == IntPtr.Zero) return;
                            if (ResizePseudoConsole(conpty, size) < 0) return;
                        }
                    } else {
                        byte[] data = requests.ReadBytes(length);
                        if (data.Length != length) return;
                        input.Write(data, 0, length);
                        input.Flush();
                    }
                }
            }
        } catch (IOException) {
            // daemon 断开输入管道或 ConPTY 关闭时结束会话。
        } catch (ObjectDisposedException) {
            // shell 已退出，主线程已释放输入管道。
        } finally {
            CloseConsole();
        }
    }

    private static void DrainOutput(SafeFileHandle handle) {
        using (var source = new FileStream(handle, FileAccess.Read, 4096, false)) {
            Stream destination = Console.OpenStandardOutput();
            var data = new byte[16384];
            try {
                int count;
                while ((count = source.Read(data, 0, data.Length)) != 0) {
                    if (destination == null) continue;
                    try {
                        destination.Write(data, 0, count);
                        destination.Flush();
                    } catch (IOException) {
                        destination = null;
                    }
                }
            } catch (IOException) {
                // ConPTY 已关闭输出管道。
            }
        }
    }

    private void CloseConsole() {
        lock (consoleLock) {
            if (conpty == IntPtr.Zero) return;
            ClosePseudoConsole(conpty);
            conpty = IntPtr.Zero;
        }
    }
}
'@
  exit [QingCodeConPty]::Run()
} catch {
  exit 1
}
`
