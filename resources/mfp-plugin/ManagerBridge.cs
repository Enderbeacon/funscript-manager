// ManagerBridge.cs — Funscript Manager ↔ MultiFunPlayer control bridge.
//
// Drop this file into MultiFunPlayer's `Plugins` directory. MFP compiles it at
// runtime (Roslyn) and lists it in the plugin panel; enable it there. It opens a
// tiny loopback HTTP server so Funscript Manager can push the exact script → axis
// assignment for the video it is playing, instead of relying on MFP's filename
// auto-matching against the manager's playback session directory. If this
// plugin is absent or disabled, the manager silently falls back to that
// matching, so nothing here is load-bearing.
//
// Protocol (must stay in sync with src/main/services/playback/mfp-bridge.ts):
//   GET  /ping   -> 200 {"name":"ManagerBridge","version":"1"}
//   POST /load   body {"video":"D:/v.mp4"?,               // optional; omit to keep current
//                      "mediaPath":"D:/v.mp4"?,           // optional; scopes the override below
//                      "scripts":{"L0":"D:/a.funscript",  // MFP axis name -> absolute path
//                                 "R1":"D:/a.roll.funscript"}}
//                -> 200 {"ok":true}
//   POST /clear  body {"axes":["L0","R1"]?,               // omit = clear nothing (must list axes)
//                      "mediaPath":"D:/v.mp4"?}
//                -> 200 {"ok":true}
//
// The manager's assignment also wins over MFP's own filename matching: the
// last /load + /clear is remembered and re-applied in
// HandleMessage(PostScriptSearchMessage), which MFP raises after searching its
// script libraries. Without that, MFP would re-attach e.g. `video.roll.funscript`
// to R1 right after we released it, and "play this single-axis version alone"
// could not be honoured. The override is scoped to `mediaPath` when given, so
// media the manager did not start are left entirely to MFP.
//
// Port: read from `managerbridge.json` (in MFP's Plugins directory) key "port";
// defaults to 57944. The manager writes that file on install so both sides agree.
//
// Why a hand-rolled TcpListener instead of HttpListener: MFP's plugin compiler
// references *only the assemblies already loaded in the process*
// (PluginCompiler.cs: AppDomain.CurrentDomain.GetAssemblies()).
// System.Net.HttpListener.dll is not loaded at plugin-compile time, so an
// HttpListener-based plugin fails to compile with CS1069 (observed on
// v1.32.1-patreon). System.Net.Sockets is loaded early by MFP's own TCP/UDP/
// WebSocket output targets, so TcpListener is safe; the wire protocol above is
// unchanged, and the manager side needs no adjustment.
//
// API provenance: the identifiers below were verified against the MultiFunPlayer
// source (Yoooi0/MultiFunPlayer, master ≈ v1.32–1.34, 2026-07) — PluginBase +
// StartTask/OnInitialize (Plugin/PluginBase.cs), PublishMessage(ChangeScriptMessage)
// / PublishMessage(MediaChangePathMessage) (Plugin/PluginBase.cs + Common/Messages.cs),
// DeviceAxis.TryParse (Common/DeviceAxis.cs), FunscriptReader.Default.FromPath ->
// ScriptReaderResult (Script/IScriptReader.cs). If a name differs in a newer build
// the plugin panel reports the compile error; the HTTP contract above never changes.

using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;

using Newtonsoft.Json.Linq;

using NLog;

using MultiFunPlayer.Common;
using MultiFunPlayer.Plugin;
using MultiFunPlayer.Script;

public class ManagerBridge : PluginBase
{
    private const string PluginName = "ManagerBridge";
    private const string PluginVersion = "1";
    private const int DefaultPort = 57944;

    private static readonly Logger Log = LogManager.GetCurrentClassLogger();

    private TcpListener _listener;

    // The manager's last assignment, re-applied whenever MFP re-runs its own
    // script search for the same media (see HandleMessage below).
    private readonly object _desiredLock = new object();
    private readonly Dictionary<string, string> _desiredScripts = new Dictionary<string, string>();
    private readonly HashSet<string> _clearedAxes = new HashSet<string>();
    private string _scopePath;

    // PluginBase drives background work through StartTask; there is no ExecuteAsync
    // override. OnInitialize runs once when MFP loads/enables the plugin.
    protected override void OnInitialize()
    {
        StartTask(RunAsync);
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        var port = ReadConfiguredPort();

        // Loopback only: never reachable from the network, and binding needs no
        // urlacl / admin rights.
        _listener = new TcpListener(IPAddress.Loopback, port);
        try
        {
            _listener.Start();
        }
        catch (Exception e)
        {
            Log.Error(e, "[ManagerBridge] failed to bind 127.0.0.1:{0}", port);
            return;
        }

        Log.Info("[ManagerBridge] listening on http://127.0.0.1:{0}/", port);

        using (cancellationToken.Register(() => { try { _listener.Stop(); } catch { } }))
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync().ConfigureAwait(false);
                }
                catch
                {
                    break; // listener stopped (cancellation) or faulted
                }

                // One short-lived connection per request; never let a bad client
                // stall the accept loop.
                _ = Task.Run(() => ServeAsync(client, cancellationToken), CancellationToken.None);
            }
        }

        try { _listener.Stop(); } catch { }
    }

    private async Task ServeAsync(TcpClient client, CancellationToken cancellationToken)
    {
        using (client)
        {
            try
            {
                client.NoDelay = true;
                var stream = client.GetStream();
                var request = await ReadRequestAsync(stream, cancellationToken).ConfigureAwait(false);
                if (request == null)
                    return;

                var response = HandleRequest(request, out var status);
                await WriteResponseAsync(stream, status, response, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception e)
            {
                Log.Warn(e, "[ManagerBridge] request handling failed");
            }
        }
    }

    private string HandleRequest(HttpRequest request, out int status)
    {
        status = 200;

        if (request.Method == "GET" && request.Path == "/ping")
            return $"{{\"name\":\"{PluginName}\",\"version\":\"{PluginVersion}\"}}";

        if (request.Method == "POST" && request.Path == "/load")
        {
            var root = JObject.Parse(request.Body);

            var video = (string)root["video"];
            if (!string.IsNullOrWhiteSpace(video))
                Publish(new MediaChangePathMessage(video));

            RememberScope((string)root["mediaPath"]);

            if (root["scripts"] is JObject scripts)
            {
                foreach (var entry in scripts)
                {
                    var scriptPath = (string)entry.Value;
                    Remember(entry.Key, scriptPath);
                    LoadScript(entry.Key, scriptPath);
                }
            }

            return "{\"ok\":true}";
        }

        if (request.Method == "POST" && request.Path == "/clear")
        {
            if (!string.IsNullOrWhiteSpace(request.Body))
            {
                var root = JObject.Parse(request.Body);
                RememberScope((string)root["mediaPath"]);
                if (root["axes"] is JArray axes)
                {
                    foreach (var a in axes)
                    {
                        Remember((string)a, null);
                        ClearAxis((string)a);
                    }
                }
            }
            return "{\"ok\":true}";
        }

        status = 404;
        return "{\"ok\":false}";
    }

    private void LoadScript(string axisName, string scriptPath)
    {
        if (!DeviceAxis.TryParse(axisName, out var axis))
        {
            Log.Warn("[ManagerBridge] unknown axis '{0}'", axisName);
            return;
        }

        // Manager stages one single-axis funscript per path, so Resource (not the
        // multi-axis Resources dict) is what we assign to this axis.
        var script = ReadScript(scriptPath);
        if (script == null)
        {
            Log.Warn("[ManagerBridge] could not read script for {0}: {1}", axisName, scriptPath);
            return;
        }

        Publish(new ChangeScriptMessage(axis, script));
    }

    private void ClearAxis(string axisName)
    {
        if (DeviceAxis.TryParse(axisName, out var axis))
            Publish(new ChangeScriptMessage(axis, (IScriptResource)null));
    }

    // --- keeping the manager's choice authoritative -------------------------

    /** Remember one axis: a script path to keep, or null to keep it empty. */
    private void Remember(string axisName, string scriptPath)
    {
        if (!DeviceAxis.TryParse(axisName, out _))
            return;
        lock (_desiredLock)
        {
            if (string.IsNullOrWhiteSpace(scriptPath))
            {
                _desiredScripts.Remove(axisName);
                _clearedAxes.Add(axisName);
            }
            else
            {
                _desiredScripts[axisName] = scriptPath;
                _clearedAxes.Remove(axisName);
            }
        }
    }

    /** A new media scope drops the previous media's assignment. */
    private void RememberScope(string mediaPath)
    {
        if (string.IsNullOrWhiteSpace(mediaPath))
            return;
        lock (_desiredLock)
        {
            if (!string.Equals(_scopePath, mediaPath, StringComparison.OrdinalIgnoreCase))
            {
                _desiredScripts.Clear();
                _clearedAxes.Clear();
                _scopePath = mediaPath;
            }
        }
    }

    private bool ScopeMatches(string path)
    {
        lock (_desiredLock)
        {
            if (string.IsNullOrWhiteSpace(_scopePath))
                return true; // manager gave no scope: its choice applies as-is
            if (string.IsNullOrWhiteSpace(path))
                return false;
            return string.Equals(
                Path.GetFullPath(_scopePath).TrimEnd('\\'),
                Path.GetFullPath(path).TrimEnd('\\'),
                StringComparison.OrdinalIgnoreCase);
        }
    }

    /**
     * MFP raises this after searching its own script libraries. Its result is
     * filename-based, so it happily re-attaches the sibling axis scripts the
     * manager just released. Rewriting the dictionary here is what makes
     * "play this version, on these axes only" actually hold.
     */
    protected override void HandleMessage(PostScriptSearchMessage message)
    {
        if (message?.Scripts == null)
            return;

        var resource = message.MediaResource;
        if (!ScopeMatches(resource?.Path ?? resource?.OriginalPath))
            return;

        Dictionary<string, string> wanted;
        List<string> cleared;
        lock (_desiredLock)
        {
            if (_desiredScripts.Count == 0 && _clearedAxes.Count == 0)
                return;
            wanted = new Dictionary<string, string>(_desiredScripts);
            cleared = new List<string>(_clearedAxes);
        }

        foreach (var axisName in cleared)
        {
            if (DeviceAxis.TryParse(axisName, out var axis))
                message.Scripts.Remove(axis);
        }

        foreach (var entry in wanted)
        {
            if (!DeviceAxis.TryParse(entry.Key, out var axis))
                continue;
            var script = ReadScript(entry.Value);
            if (script != null)
                message.Scripts[axis] = script;
            else
                message.Scripts.Remove(axis);
        }

        Log.Info("[ManagerBridge] re-applied manager assignment after script search ({0} set, {1} cleared)",
            wanted.Count, cleared.Count);
    }

    private static IScriptResource ReadScript(string scriptPath)
    {
        if (string.IsNullOrWhiteSpace(scriptPath) || !File.Exists(scriptPath))
            return null;
        var result = FunscriptReader.Default.FromPath(scriptPath);
        return result.IsSuccess ? result.Resource : null;
    }

    // ChangeScriptMessage / MediaChangePathMessage handlers may touch UI-bound
    // observable collections; marshal onto MFP's WPF dispatcher to be safe.
    private void Publish(ChangeScriptMessage message) => Dispatch(() => PublishMessage(message));
    private void Publish(MediaChangePathMessage message) => Dispatch(() => PublishMessage(message));

    private static void Dispatch(Action action)
    {
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher != null && !dispatcher.CheckAccess())
            dispatcher.Invoke(action);
        else
            action();
    }

    private static int ReadConfiguredPort()
    {
        // A runtime-compiled plugin has no Assembly.Location, so locate the config
        // relative to MFP's install dir (AppContext.BaseDirectory)/Plugins.
        foreach (var dir in new[]
                 {
                     Path.Combine(AppContext.BaseDirectory ?? ".", "Plugins"),
                     Path.Combine(Directory.GetCurrentDirectory(), "Plugins")
                 })
        {
            try
            {
                var cfg = Path.Combine(dir, "managerbridge.json");
                if (!File.Exists(cfg))
                    continue;
                var port = (int?)JObject.Parse(File.ReadAllText(cfg))["port"];
                if (port is > 0 and < 65536)
                    return port.Value;
            }
            catch (Exception e)
            {
                Log.Warn(e, "[ManagerBridge] could not read managerbridge.json in {0}", dir);
            }
        }
        return DefaultPort;
    }

    // --- minimal HTTP/1.1 over TcpClient -----------------------------------
    // Only what this bridge speaks: one request per connection, no chunked
    // bodies, no keep-alive. Both peers are on loopback and the manager is the
    // only client, so there is nothing to negotiate.

    private sealed class HttpRequest
    {
        public string Method;
        public string Path;
        public string Body;
    }

    private const int MaxHeaderBytes = 16 * 1024;
    private const int MaxBodyBytes = 4 * 1024 * 1024;

    private static async Task<HttpRequest> ReadRequestAsync(NetworkStream stream, CancellationToken cancellationToken)
    {
        var chunk = new byte[4096];
        var received = new MemoryStream();
        var headerEnd = -1;

        while (headerEnd < 0)
        {
            var read = await stream.ReadAsync(chunk, 0, chunk.Length, cancellationToken).ConfigureAwait(false);
            if (read <= 0)
                return null; // client hung up before finishing the headers
            received.Write(chunk, 0, read);
            headerEnd = IndexOfHeaderEnd(received.GetBuffer(), (int)received.Length);
            if (headerEnd < 0 && received.Length > MaxHeaderBytes)
                return null;
        }

        var raw = received.GetBuffer();
        var buffered = (int)received.Length;
        var headerLines = Encoding.UTF8.GetString(raw, 0, headerEnd).Split(new[] { "\r\n" }, StringSplitOptions.None);
        var requestLine = headerLines[0].Split(' ');
        if (requestLine.Length < 2)
            return null;

        var contentLength = 0;
        for (var i = 1; i < headerLines.Length; i++)
        {
            var colon = headerLines[i].IndexOf(':');
            if (colon <= 0)
                continue;
            if (!headerLines[i].Substring(0, colon).Trim().Equals("content-length", StringComparison.OrdinalIgnoreCase))
                continue;
            int.TryParse(headerLines[i].Substring(colon + 1).Trim(), out contentLength);
        }
        if (contentLength < 0 || contentLength > MaxBodyBytes)
            return null;

        var body = new byte[contentLength];
        var bodyStart = headerEnd + 4;
        var have = Math.Max(0, Math.Min(contentLength, buffered - bodyStart));
        if (have > 0)
            Buffer.BlockCopy(raw, bodyStart, body, 0, have);
        while (have < contentLength)
        {
            var read = await stream.ReadAsync(body, have, contentLength - have, cancellationToken).ConfigureAwait(false);
            if (read <= 0)
                break;
            have += read;
        }

        var target = requestLine[1];
        var query = target.IndexOf('?');
        if (query >= 0)
            target = target.Substring(0, query);

        return new HttpRequest
        {
            Method = requestLine[0],
            Path = target,
            Body = Encoding.UTF8.GetString(body, 0, have)
        };
    }

    /** Index of the CRLFCRLF that ends the header block, or -1. */
    private static int IndexOfHeaderEnd(byte[] buffer, int length)
    {
        for (var i = 0; i + 3 < length; i++)
        {
            if (buffer[i] == (byte)'\r' && buffer[i + 1] == (byte)'\n' &&
                buffer[i + 2] == (byte)'\r' && buffer[i + 3] == (byte)'\n')
                return i;
        }
        return -1;
    }

    private static async Task WriteResponseAsync(NetworkStream stream, int status, string json, CancellationToken cancellationToken)
    {
        var payload = Encoding.UTF8.GetBytes(json);
        var reason = status == 200 ? "OK" : status == 404 ? "Not Found" : "Internal Server Error";
        var head = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 {status} {reason}\r\n" +
            "Content-Type: application/json\r\n" +
            $"Content-Length: {payload.Length}\r\n" +
            "Connection: close\r\n\r\n");

        await stream.WriteAsync(head, 0, head.Length, cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(payload, 0, payload.Length, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }
}
