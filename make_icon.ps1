Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# Фон со скруглением (rounded square) и диагональным градиентом
$rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$c1 = [System.Drawing.Color]::FromArgb(255, 99, 102, 241)   # индиго
$c2 = [System.Drawing.Color]::FromArgb(255, 168, 85, 247)   # фиолетовый
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45.0)

$radius = 220
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()
$g.FillPath($brush, $path)

# Корпус камеры (белый скруглённый прямоугольник)
$camBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
$cx = 200; $cy = 320; $cw = 624; $ch = 384; $cr = 70
$cd = $cr * 2
$camPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$camPath.AddArc($cx, $cy, $cd, $cd, 180, 90)
$camPath.AddArc($cx + $cw - $cd, $cy, $cd, $cd, 270, 90)
$camPath.AddArc($cx + $cw - $cd, $cy + $ch - $cd, $cd, $cd, 0, 90)
$camPath.AddArc($cx, $cy + $ch - $cd, $cd, $cd, 90, 90)
$camPath.CloseFigure()
$g.FillPath($camBrush, $camPath)

# Объектив (кольцо)
$lensCx = $cx + $cw / 2
$lensCy = $cy + $ch / 2
$lensR = 130
$ringBrush = New-Object System.Drawing.SolidBrush($c2)
$g.FillEllipse($ringBrush, $lensCx - $lensR, $lensCy - $lensR, $lensR * 2, $lensR * 2)
$innerR = 78
$innerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 30, 50))
$g.FillEllipse($innerBrush, $lensCx - $innerR, $lensCy - $innerR, $innerR * 2, $innerR * 2)
# Блик на объективе
$hlBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(160, 255, 255, 255))
$g.FillEllipse($hlBrush, $lensCx - 30, $lensCy - 55, 46, 46)

# Видоискатель сверху
$g.FillRectangle($camBrush, $cx + 90, $cy - 70, 200, 90)

$g.Dispose()

$out = Join-Path $PSScriptRoot "app-icon.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "Иконка сохранена: $out"
