param(
    [string]$Headline = 'Hello world',
    [string]$Detail = 'Windows notifications are ready',
    [string]$CodePath = '',
    [string]$TargetWindowMarker = '',
    [string]$TargetSwitch = '',
    [string]$TargetUri = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class ProcessWatcherWindowActivation
{
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr windowHandle, int command);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr windowHandle);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr windowHandle);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr windowHandle);

    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr windowHandle);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr windowHandle, IntPtr processId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint sourceThreadId, uint targetThreadId, bool attach);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    public static bool RestoreAndActivate(IntPtr windowHandle)
    {
        if (windowHandle == IntPtr.Zero)
        {
            return false;
        }

        if (IsIconic(windowHandle))
        {
            ShowWindow(windowHandle, 9);
        }
        IntPtr foregroundWindow = GetForegroundWindow();
        uint foregroundThread = GetWindowThreadProcessId(foregroundWindow, IntPtr.Zero);
        uint targetThread = GetWindowThreadProcessId(windowHandle, IntPtr.Zero);
        uint currentThread = GetCurrentThreadId();
        bool attachedToForeground = foregroundThread != 0 && currentThread != foregroundThread
            && AttachThreadInput(currentThread, foregroundThread, true);
        bool attachedToTarget = targetThread != 0 && currentThread != targetThread
            && AttachThreadInput(currentThread, targetThread, true);
        try
        {
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            BringWindowToTop(windowHandle);
            SetForegroundWindow(windowHandle);
            SetFocus(windowHandle);
            return GetForegroundWindow() == windowHandle;
        }
        finally
        {
            if (attachedToTarget)
            {
                AttachThreadInput(currentThread, targetThread, false);
            }
            if (attachedToForeground)
            {
                AttachThreadInput(currentThread, foregroundThread, false);
            }
        }
    }
}
'@

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="390" Height="118"
        WindowStyle="None" ResizeMode="NoResize"
        AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" ShowActivated="False"
        Topmost="True" Focusable="False" Opacity="0" Cursor="Hand">
        <Border x:Name="ToastSurface"
            Background="#20252B"
            BorderBrush="#3B4651"
            BorderThickness="1"
            CornerRadius="8">
        <Border.Effect>
            <DropShadowEffect BlurRadius="18" Direction="270"
                              ShadowDepth="5" Opacity="0.55"
                              Color="#000000" />
        </Border.Effect>
        <Grid>
            <Grid.ColumnDefinitions>
                <ColumnDefinition Width="5" />
                <ColumnDefinition Width="58" />
                <ColumnDefinition Width="*" />
                <ColumnDefinition Width="38" />
            </Grid.ColumnDefinitions>

            <Border Grid.Column="0" Background="#66C0F4"
                    CornerRadius="8,0,0,8" />

            <Grid Grid.Column="1" Width="36" Height="36">
                <Viewbox Width="34" Height="34">
                    <Canvas Width="24" Height="24">
                        <Path Fill="#66C0F4"
                              Data="M12,2 A10,10 0 1 0 22,12 A10.01,10.01 0 0 0 12,2 M12,20 A8,8 0 1 1 20,12 A8.01,8.01 0 0 1 12,20 Z" />
                        <Path Fill="#EAF6FF"
                              Data="M11,6 L13,6 L13,11.17 L16.24,14.41 L14.82,15.83 L11,12 Z" />
                        <Ellipse Canvas.Left="16" Canvas.Top="3" Width="5" Height="5"
                                 Fill="#66C0F4" />
                    </Canvas>
                </Viewbox>
            </Grid>

            <StackPanel Grid.Column="2" VerticalAlignment="Center">
                <TextBlock Text="PROCESS WATCHER"
                           Foreground="#66C0F4"
                           FontFamily="Segoe UI"
                           FontSize="11"
                           FontWeight="SemiBold" />
                <TextBlock x:Name="HeadlineText"
                           Margin="0,4,0,0"
                           Foreground="#F4F7FA"
                           FontFamily="Segoe UI"
                           FontSize="18"
                           TextTrimming="CharacterEllipsis"
                           FontWeight="SemiBold" />
                <TextBlock x:Name="DetailText"
                           Margin="0,3,0,0"
                           Foreground="#A9B4BE"
                           FontFamily="Segoe UI"
                           TextTrimming="CharacterEllipsis"
                           FontSize="12" />
            </StackPanel>

            <Button x:Name="CloseButton" Grid.Column="3"
                    Width="28" Height="28" Margin="0,8,7,0"
                    HorizontalAlignment="Right" VerticalAlignment="Top"
                    Content="x" FontFamily="Segoe UI" FontSize="14"
                    BorderThickness="0" Cursor="Hand">
                <Button.Style>
                    <Style TargetType="Button">
                        <Setter Property="Foreground" Value="#A9B4BE" />
                        <Setter Property="Background" Value="Transparent" />
                        <Setter Property="Template">
                            <Setter.Value>
                                <ControlTemplate TargetType="Button">
                                    <Border Background="{TemplateBinding Background}"
                                            CornerRadius="3">
                                        <ContentPresenter HorizontalAlignment="Center"
                                                          VerticalAlignment="Center" />
                                    </Border>
                                    <ControlTemplate.Triggers>
                                        <Trigger Property="IsMouseOver" Value="True">
                                            <Setter Property="Foreground" Value="#FFFFFF" />
                                            <Setter Property="Background" Value="#D94B4B" />
                                        </Trigger>
                                    </ControlTemplate.Triggers>
                                </ControlTemplate>
                            </Setter.Value>
                        </Setter>
                    </Style>
                </Button.Style>
            </Button>
        </Grid>
    </Border>
</Window>
'@

$window = [Windows.Markup.XamlReader]::Parse($xaml)
$toastSurface = $window.FindName('ToastSurface')
$closeButton = $window.FindName('CloseButton')
$window.FindName('HeadlineText').Text = $Headline
$window.FindName('DetailText').Text = $Detail
$workArea = [System.Windows.SystemParameters]::WorkArea
$targetLeft = $workArea.Right - $window.Width - 20
$slotDirectory = Join-Path ([System.IO.Path]::GetTempPath()) 'process-watcher-toast-slots'
$slotMutex = New-Object System.Threading.Mutex($false, 'Local\ProcessWatcherToastSlots')
$slot = 0
$slotFile = $null

try {
    [void]$slotMutex.WaitOne()
    [System.IO.Directory]::CreateDirectory($slotDirectory) | Out-Null
    $occupiedSlots = @{}
    Get-ChildItem -LiteralPath $slotDirectory -Filter '*.pid' -ErrorAction SilentlyContinue | ForEach-Object {
        $ownerPid = 0
        if ([int]::TryParse((Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue), [ref]$ownerPid) -and
            (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
            $occupiedSlots[[int]$_.BaseName] = $true
        } else {
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
        }
    }
    while ($occupiedSlots.ContainsKey($slot)) {
        $slot++
    }
    $slotFile = Join-Path $slotDirectory "$slot.pid"
    [System.IO.File]::WriteAllText($slotFile, [string]$PID)
} finally {
    try { $slotMutex.ReleaseMutex() } catch { }
    $slotMutex.Dispose()
}

$targetTop = $workArea.Bottom - $window.Height - 20 - ($slot * ($window.Height + 12))
$window.Left = $targetLeft
$window.Top = $targetTop + 24

$closing = $false

function Close-Toast {
    if ($script:closing) {
        return
    }
    $script:closing = $true

    $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
    $fade.To = 0
    $fade.Duration = [TimeSpan]::FromMilliseconds(180)

    $slide = New-Object System.Windows.Media.Animation.DoubleAnimation
    $slide.To = $script:targetTop + 12
    $slide.Duration = [TimeSpan]::FromMilliseconds(180)

    $fade.Add_Completed({ $script:window.Close() })
    $script:window.BeginAnimation([System.Windows.Window]::OpacityProperty, $fade)
    $script:window.BeginAnimation([System.Windows.Window]::TopProperty, $slide)
}

$closeButton.Add_Click({ Close-Toast })
$toastClickHandler = [System.Windows.Input.MouseButtonEventHandler]{
    param($sender, $eventArgs)

    if (-not $script:closing -and -not $script:closeButton.IsMouseOver) {
        $activated = $false
        if ($script:TargetWindowMarker) {
            $codeProcessName = [System.IO.Path]::GetFileNameWithoutExtension($script:CodePath)
            $targetProcess = Get-Process -Name $codeProcessName -ErrorAction SilentlyContinue |
                Where-Object { $_.MainWindowTitle -like "*$($script:TargetWindowMarker)*" } |
                Select-Object -First 1
            if ($targetProcess -and $targetProcess.MainWindowHandle -ne [IntPtr]::Zero) {
                $activated = [ProcessWatcherWindowActivation]::RestoreAndActivate(
                    $targetProcess.MainWindowHandle
                )
            }
        }
        if (-not $activated -and $script:CodePath -and $script:TargetSwitch -and $script:TargetUri) {
            Start-Process -FilePath $script:CodePath -ArgumentList @(
                '--reuse-window',
                $script:TargetSwitch,
                $script:TargetUri
            )
        }
        $eventArgs.Handled = $true
    }
}
$toastSurface.AddHandler(
    [System.Windows.UIElement]::MouseLeftButtonUpEvent,
    $toastClickHandler,
    $true
)
$window.Add_Closed({
    if ($script:slotFile) {
        Remove-Item -LiteralPath $script:slotFile -Force -ErrorAction SilentlyContinue
    }
})
$window.Add_Loaded({
    $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
    $fade.From = 0
    $fade.To = 1
    $fade.Duration = [TimeSpan]::FromMilliseconds(220)

    $slide = New-Object System.Windows.Media.Animation.DoubleAnimation
    $slide.From = $script:targetTop + 24
    $slide.To = $script:targetTop
    $slide.Duration = [TimeSpan]::FromMilliseconds(280)

    $script:window.BeginAnimation([System.Windows.Window]::OpacityProperty, $fade)
    $script:window.BeginAnimation([System.Windows.Window]::TopProperty, $slide)
})

[void]$window.ShowDialog()