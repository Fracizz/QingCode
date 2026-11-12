& (& {
    $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $env:QINGCODE_PREWARM_PIPE, 'InOut')
    [Environment]::SetEnvironmentVariable('QINGCODE_PREWARM_PIPE', $null, 'Process')
    try {
        $pipe.Connect(20000)
        $reader = [IO.BinaryReader]::new($pipe)
        $length = $reader.ReadInt32()
        $bytes = $reader.ReadBytes($length)
        if ($bytes.Length -ne $length) { return {} }
        $command = [Text.Encoding]::UTF8.GetString($bytes)
        $pipe.WriteByte(1)
        if ($pipe.ReadByte() -ne 1) { return {} }
        $pipe.WriteByte(1)
    } finally {
        $pipe.Dispose()
    }
    [ScriptBlock]::Create($command)
})
