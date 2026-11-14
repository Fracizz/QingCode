& (& {
    $line = [Text.StringBuilder]::new()
    while ($true) {
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq [ConsoleKey]::Enter) { break }
        [void]$line.Append($key.KeyChar)
    }
    if ($line.Length -eq 0) { return {} }
    try {
        [ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.ToString())))
    } catch {
        {}
    }
})
