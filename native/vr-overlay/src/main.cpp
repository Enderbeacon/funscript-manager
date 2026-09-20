// vr-overlay: puts the app's VR panels into SteamVR as overlays.
//
// Each panel is a web page the app renders off screen. This process only owns
// the SteamVR side: it shows the pixels it is given on floating panels, places
// them in the world (the main panel also on the left wrist), lets the viewer
// grab and carry each one, offers a button on the right wrist that brings the
// main panel back, and reports what the controllers do on them.
//
// stdin, from the app — binary messages, little endian:
//   u32 type, u32 length, then `length` bytes of payload.
//   A message about one panel carries the panel's number in the type's high
//   16 bits. Panel 0 is the main panel, so a message without one goes there.
// stdout, to the app — one JSON object per line; `p` names the panel.
// stderr — log lines.
//
// The process outlives SteamVR: when SteamVR is not running it waits for it,
// and when SteamVR quits it goes back to waiting. It exits when stdin closes.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "openvr.h"

namespace {

// ------------------------------------------------------------------ protocol

enum MessageType : uint32_t {
  kFrame = 1,        // u32 fullW, fullH, x, y, w, h; then w*h*4 bytes BGRA
  kShow = 2,
  kHide = 3,
  kMode = 4,         // u32: 0 = in the world, 1 = on the left wrist
  kRecenter = 5,     // put the panel in front of the head; any other beside the main one
  kKeyboard = 6,     // u32 open; then UTF-8 text already in the field
  kPlacement = 8,    // float[12]: where the panel stood last time (row-major 3x4)
  kSize = 9,         // float world width, float wrist width, in metres
  kButtonImage = 10, // u32 w, h; then w*h*4 bytes BGRA: the wrist button
  kAlpha = 11,       // float: how opaque the whole panel is, 0..1
};

// The main panel and the script player's panel.
constexpr uint32_t kPanelCount = 2;

std::mutex g_outMutex;

void Emit(const std::string& json) {
  std::lock_guard<std::mutex> lock(g_outMutex);
  fwrite(json.data(), 1, json.size(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

void Log(const char* fmt, ...) {
  char buf[1024];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof buf, fmt, args);
  va_end(args);
  std::lock_guard<std::mutex> lock(g_outMutex);
  fprintf(stderr, "%s\n", buf);
  fflush(stderr);
}

std::string JsonString(const char* s) {
  std::string out = "\"";
  for (const unsigned char* p = reinterpret_cast<const unsigned char*>(s); *p; ++p) {
    switch (*p) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (*p < 0x20) {
          char esc[8];
          snprintf(esc, sizeof esc, "\\u%04x", *p);
          out += esc;
        } else {
          out += static_cast<char>(*p);
        }
    }
  }
  return out + "\"";
}

// A picture waiting to go to the GPU. Paints are merged straight into one
// copy of the whole surface, so a burst of them costs one upload.
struct Picture {
  std::vector<uint8_t> pixels;  // BGRA, width * height * 4
  uint32_t width = 0, height = 0;
  bool dirty = false;
  uint32_t x0 = 0, y0 = 0, x1 = 0, y1 = 0;

  void MarkAllDirty() {
    if (width == 0) return;
    dirty = true;
    x0 = y0 = 0;
    x1 = width;
    y1 = height;
  }
};

// Everything that arrives on stdin.
struct Inbox {
  std::mutex mutex;
  Picture panels[kPanelCount];
  Picture button;
  std::deque<std::pair<uint32_t, std::vector<uint8_t>>> commands;
  std::atomic<bool> closed{false};
};

Inbox g_inbox;
// Set whenever something lands in the inbox, so the loop picks it up at once.
HANDLE g_inboxSignal = CreateEventW(nullptr, FALSE, FALSE, nullptr);

bool ReadExact(HANDLE in, void* dst, size_t size) {
  auto* p = static_cast<uint8_t*>(dst);
  while (size > 0) {
    DWORD got = 0;
    DWORD chunk = static_cast<DWORD>(std::min<size_t>(size, 1 << 20));
    if (!ReadFile(in, p, chunk, &got, nullptr) || got == 0) return false;
    p += got;
    size -= got;
  }
  return true;
}

// Copies a rectangle of pixels into `pic`, resizing it when the full size changed.
void Paint(Picture& pic, uint32_t fullW, uint32_t fullH, uint32_t x, uint32_t y, uint32_t w, uint32_t h,
           const uint8_t* src) {
  if (pic.width != fullW || pic.height != fullH) {
    pic.width = fullW;
    pic.height = fullH;
    pic.pixels.assign(static_cast<size_t>(fullW) * fullH * 4, 0);
    pic.dirty = false;
  }
  for (uint32_t row = 0; row < h; ++row) {
    memcpy(&pic.pixels[(static_cast<size_t>(y + row) * fullW + x) * 4],
           src + static_cast<size_t>(row) * w * 4, static_cast<size_t>(w) * 4);
  }
  if (!pic.dirty) {
    pic.x0 = x; pic.y0 = y; pic.x1 = x + w; pic.y1 = y + h;
    pic.dirty = true;
  } else {
    pic.x0 = std::min(pic.x0, x);
    pic.y0 = std::min(pic.y0, y);
    pic.x1 = std::max(pic.x1, x + w);
    pic.y1 = std::max(pic.y1, y + h);
  }
}

bool ValidRect(uint32_t fullW, uint32_t fullH, uint32_t x, uint32_t y, uint32_t w, uint32_t h, size_t bytes) {
  if (fullW == 0 || fullH == 0 || fullW > 8192 || fullH > 8192) return false;
  if (x + w > fullW || y + h > fullH) return false;
  return bytes >= static_cast<size_t>(w) * h * 4;
}

void ReadStdin() {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  std::vector<uint8_t> payload;
  for (;;) {
    uint32_t header[2];
    if (!ReadExact(in, header, sizeof header)) break;
    payload.resize(header[1]);
    if (header[1] > 0 && !ReadExact(in, payload.data(), header[1])) break;

    const uint32_t type = header[0] & 0xffff;
    const uint32_t panel = header[0] >> 16;
    if (panel >= kPanelCount) {
      Log("message %u for panel %u, which does not exist", type, panel);
      continue;
    }
    if (type == kFrame) {
      if (payload.size() < 24) continue;
      uint32_t f[6];
      memcpy(f, payload.data(), sizeof f);
      if (!ValidRect(f[0], f[1], f[2], f[3], f[4], f[5], payload.size() - 24)) continue;
      std::lock_guard<std::mutex> lock(g_inbox.mutex);
      Paint(g_inbox.panels[panel], f[0], f[1], f[2], f[3], f[4], f[5], payload.data() + 24);
    } else if (type == kButtonImage) {
      if (payload.size() < 8) continue;
      uint32_t f[2];
      memcpy(f, payload.data(), sizeof f);
      if (!ValidRect(f[0], f[1], 0, 0, f[0], f[1], payload.size() - 8)) continue;
      std::lock_guard<std::mutex> lock(g_inbox.mutex);
      Paint(g_inbox.button, f[0], f[1], 0, 0, f[0], f[1], payload.data() + 8);
    } else {
      std::lock_guard<std::mutex> lock(g_inbox.mutex);
      g_inbox.commands.emplace_back(header[0], payload);
    }
    SetEvent(g_inboxSignal);
  }
  g_inbox.closed = true;
  SetEvent(g_inboxSignal);
}

// ------------------------------------------------------------------- math

using Mat = vr::HmdMatrix34_t;

Mat Identity() {
  Mat m{};
  m.m[0][0] = m.m[1][1] = m.m[2][2] = 1.f;
  return m;
}

Mat Multiply(const Mat& a, const Mat& b) {
  Mat r{};
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 4; ++j) {
      r.m[i][j] = a.m[i][0] * b.m[0][j] + a.m[i][1] * b.m[1][j] + a.m[i][2] * b.m[2][j];
    }
    r.m[i][3] += a.m[i][3];
  }
  return r;
}

// Inverse of a rotation plus translation.
Mat InvertRigid(const Mat& a) {
  Mat r{};
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) r.m[i][j] = a.m[j][i];
  }
  for (int i = 0; i < 3; ++i) {
    r.m[i][3] = -(r.m[i][0] * a.m[0][3] + r.m[i][1] * a.m[1][3] + r.m[i][2] * a.m[2][3]);
  }
  return r;
}

Mat RotationX(float radians) {
  Mat m = Identity();
  m.m[1][1] = std::cos(radians); m.m[1][2] = -std::sin(radians);
  m.m[2][1] = std::sin(radians); m.m[2][2] = std::cos(radians);
  return m;
}

Mat RotationY(float radians) {
  Mat m = Identity();
  m.m[0][0] = std::cos(radians); m.m[0][2] = std::sin(radians);
  m.m[2][0] = -std::sin(radians); m.m[2][2] = std::cos(radians);
  return m;
}

// ------------------------------------------------------------------ overlay

constexpr const char* kPanelKeys[kPanelCount] = {"funscript-manager.panel", "funscript-manager.panel.1"};
constexpr char kButtonKey[] = "funscript-manager.summon";
constexpr char kOverlayName[] = "Funscript Manager";
constexpr vr::ETrackingUniverseOrigin kUniverse = vr::TrackingUniverseStanding;

// On the wrist the panel sits above the back of the left controller, tipped
// towards the eyes, the way one would hold up a watch.
Mat WristOffset() {
  Mat m = RotationX(-1.05f);  // about 60 degrees: mostly facing up, a little back
  m.m[0][3] = 0.f;
  m.m[1][3] = 0.07f;
  m.m[2][3] = 0.13f;
  return m;
}

// The summon button lies on the back of the right wrist, facing out of it.
// Controller space: +X is the controller's right side, +Z points back along
// the forearm.
constexpr float kButtonWidth = 0.07f;
Mat ButtonOffset() {
  Mat m = RotationY(1.5708f);  // the button's face (+Z) turned to the controller's +X
  m.m[0][3] = 0.045f;
  m.m[1][3] = 0.01f;
  m.m[2][3] = 0.11f;
  return m;
}

// How squarely the back of the right hand has to face the eyes before the
// button shows, and how far it may turn away again before it goes. The gap
// keeps it from flickering at the edge.
constexpr float kFacingShow = 0.75f;  // cos 41 degrees
constexpr float kFacingHide = 0.5f;   // cos 60 degrees

// A panel opened beside the main one: this far from its right edge, and
// turned this much towards the viewer so the two wrap around them.
constexpr float kBesideGap = 0.04f;
constexpr float kBesideTurn = 0.35f;  // about 20 degrees

// Whether an overlay currently takes the controllers. SteamVR's laser, and
// with it all controller input, goes to our overlays only while a laser points
// at one; the rest of the time the controllers belong to the app underneath.
struct Pointing {
  bool interactive = false;
  double lastHit = 0;
};

// A laser that slips off an overlay's edge for less than this keeps it, so the
// input does not flicker between us and the app underneath.
constexpr double kPointingLingerMs = 150;

// Both hands carry a laser and both may land on the same panel, while the page
// behind it has one mouse pointer. One laser holds that pointer at a time.
constexpr uint32_t kCursorCount = 2;

// In panel pixels: how far a laser must travel to count as moving rather than
// resting in someone's hand, and how far the other hand must then travel to
// take the pointer from the hand holding it. A hand pointing somewhere else
// wins the pointer long before its owner finishes a sentence about it.
constexpr float kLaserNoise = 3.f;
constexpr float kLaserTakeOver = 48.f;

// One laser on one panel.
struct Laser {
  bool onPanel = false;
  bool placed = false;  // a position has been seen since it arrived
  float x = 0, y = 0;
  float travelled = 0;  // towards taking the pointer, spent by the holder moving
  vr::TrackedDeviceIndex_t device = vr::k_unTrackedDeviceIndexInvalid;
};

// A texture that feeds one overlay.
struct Surface {
  vr::VROverlayHandle_t handle = vr::k_ulOverlayHandleInvalid;
  ID3D11Texture2D* texture = nullptr;
  uint32_t width = 0, height = 0;

  void Release() {
    if (texture) { texture->Release(); texture = nullptr; }
    width = height = 0;
    handle = vr::k_ulOverlayHandleInvalid;
  }
};

// One floating panel and everything known about where it is.
struct Panel {
  uint32_t index = 0;
  Surface surface;

  uint32_t mode = 0;
  bool placed = false;  // world placement known (restored, recentred, placed beside or carried)
  Mat worldPose = Identity();
  float worldWidth = 0.9f;
  float wristWidth = 0.32f;
  float alpha = 1.f;
  bool visible = false;
  bool keyboardOpen = false;

  // SteamVR's two lasers (0 primary, 1 secondary) and which of them the page's
  // pointer follows. `holding` means the pointer's laser has the trigger down,
  // so it is in the middle of a click or a drag and keeps the pointer.
  Laser lasers[kCursorCount];
  uint32_t pointerCursor = 0;
  bool holding = false;
  Pointing pointing;
  bool logNextMove = false;
};

class Overlays {
 public:
  Overlays() {
    for (uint32_t i = 0; i < kPanelCount; ++i) panels_[i].index = i;
  }

  bool Start();
  void Stop();
  // False once SteamVR has gone away.
  bool Tick();

  void HandleCommand(uint32_t type, const std::vector<uint8_t>& payload);

 private:
  bool CreateDevice();
  bool Upload(Surface& surface, Picture& pic, bool mouseScale);
  void SetVisible(Panel& panel, bool visible);
  Mat FrontPose();
  void Recenter(Panel& panel);
  void PlaceBeside(Panel& panel);
  void SetMode(Panel& panel, uint32_t mode);
  void StartDrag(Panel& panel, vr::TrackedDeviceIndex_t device);
  void EndDrag();
  void ApplyPlacement(Panel& panel);
  void KeepTop(Panel& panel, uint32_t oldWidth, uint32_t oldHeight);
  void EmitPlacement(const Panel& panel);
  void PollPanelEvents(Panel& panel);
  void PollButtonEvents();
  void UpdateButton();
  bool PointerRay(int hand, Mat* ray);
  void UpdatePointing(Surface& surface, Pointing& pointing, bool shown, bool hold, const char* name, bool* logMove);
  bool DevicePose(vr::TrackedDeviceIndex_t device, Mat* out);

  vr::IVRSystem* system_ = nullptr;
  vr::IVROverlay* overlay_ = nullptr;

  ID3D11Device* device_ = nullptr;
  ID3D11DeviceContext* context_ = nullptr;
  Panel panels_[kPanelCount];
  Surface button_;

  // One panel is carried at a time, attached to the controller holding it.
  Panel* dragging_ = nullptr;
  vr::TrackedDeviceIndex_t dragDevice_ = vr::k_unTrackedDeviceIndexInvalid;
  Mat dragOffset_ = Identity();

  bool buttonShown_ = false;

  // Where each hand's laser starts and points. SteamVR draws it from the
  // controller's tip, which sits at a fixed offset from the controller's own
  // pose; the offset is learned from the input system and applied to the
  // tracking pose, which keeps coming while SteamVR's laser holds the input.
  vr::IVRInput* input_ = nullptr;
  vr::VRActionSetHandle_t actionSet_ = vr::k_ulInvalidActionSetHandle;
  vr::VRActionHandle_t pointerAction_ = vr::k_ulInvalidActionHandle;
  vr::VRInputValueHandle_t hands_[2] = {vr::k_ulInvalidInputValueHandle, vr::k_ulInvalidInputValueHandle};
  Mat tipOffset_[2] = {Identity(), Identity()};
  bool tipKnown_[2] = {false, false};

  Pointing buttonPointing_;
  double nextFacingLog_ = 0;
};

double NowMs() {
  static LARGE_INTEGER freq = [] { LARGE_INTEGER f; QueryPerformanceFrequency(&f); return f; }();
  LARGE_INTEGER now;
  QueryPerformanceCounter(&now);
  return 1000.0 * static_cast<double>(now.QuadPart) / static_cast<double>(freq.QuadPart);
}

bool Overlays::CreateDevice() {
  int32_t adapterIndex = -1;
  system_->GetDXGIOutputInfo(&adapterIndex);

  IDXGIAdapter* adapter = nullptr;
  if (adapterIndex >= 0) {
    IDXGIFactory1* factory = nullptr;
    if (SUCCEEDED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory)))) {
      IDXGIAdapter1* a1 = nullptr;
      if (SUCCEEDED(factory->EnumAdapters1(adapterIndex, &a1))) adapter = a1;
      factory->Release();
    }
  }
  const HRESULT hr = D3D11CreateDevice(
      adapter, adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE, nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &device_, nullptr, &context_);
  if (adapter) adapter->Release();
  if (FAILED(hr)) {
    Log("D3D11CreateDevice failed: 0x%08lx", static_cast<unsigned long>(hr));
    return false;
  }
  return true;
}

// Sends what changed in `pic` to the overlay. Called with the inbox locked.
bool Overlays::Upload(Surface& surface, Picture& pic, bool mouseScale) {
  if (!pic.dirty || pic.width == 0) return false;

  const bool resized = !surface.texture || surface.width != pic.width || surface.height != pic.height;
  if (resized) {
    if (surface.texture) { surface.texture->Release(); surface.texture = nullptr; }
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = pic.width;
    desc.Height = pic.height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    if (FAILED(device_->CreateTexture2D(&desc, nullptr, &surface.texture))) {
      Log("CreateTexture2D %ux%u failed", pic.width, pic.height);
      return false;
    }
    surface.width = pic.width;
    surface.height = pic.height;
    if (mouseScale) {
      // Mouse events arrive in texture pixels.
      vr::HmdVector2_t scale{static_cast<float>(pic.width), static_cast<float>(pic.height)};
      overlay_->SetOverlayMouseScale(surface.handle, &scale);
    }
  }

  D3D11_BOX box = resized ? D3D11_BOX{0, 0, 0, pic.width, pic.height, 1}
                          : D3D11_BOX{pic.x0, pic.y0, 0, pic.x1, pic.y1, 1};
  const size_t pitch = static_cast<size_t>(pic.width) * 4;
  const uint8_t* src = pic.pixels.data() + box.top * pitch + box.left * 4;
  context_->UpdateSubresource(surface.texture, 0, &box, src, static_cast<UINT>(pitch), 0);
  pic.dirty = false;

  vr::Texture_t tex{surface.texture, vr::TextureType_DirectX, vr::ColorSpace_Auto};
  const vr::EVROverlayError err = overlay_->SetOverlayTexture(surface.handle, &tex);
  // SteamVR's copy of the texture is queued on our own device, after the
  // upload. Left there it only runs when something else flushes — the next
  // upload — and the overlay shows each picture one change late; the last
  // change before the page goes still is never seen at all.
  context_->Flush();
  if (err != vr::VROverlayError_None) {
    Log("SetOverlayTexture failed: %s", overlay_->GetOverlayErrorNameFromEnum(err));
  }
  return true;
}

bool Overlays::Start() {
  vr::EVRInitError error = vr::VRInitError_None;
  system_ = vr::VR_Init(&error, vr::VRApplication_Overlay);
  if (error != vr::VRInitError_None) {
    Log("VR_Init failed: %s", vr::VR_GetVRInitErrorAsEnglishDescription(error));
    system_ = nullptr;
    return false;
  }
  overlay_ = vr::VROverlay();
  input_ = vr::VRInput();

  if (!CreateDevice()) { Stop(); return false; }

  // A previous copy of us may still hold the keys while SteamVR tidies up.
  bool created = overlay_->CreateOverlay(kButtonKey, kOverlayName, &button_.handle) == vr::VROverlayError_None;
  for (Panel& panel : panels_) {
    created = created &&
              overlay_->CreateOverlay(kPanelKeys[panel.index], kOverlayName, &panel.surface.handle) ==
                  vr::VROverlayError_None;
  }
  if (!created) {
    Log("CreateOverlay failed");
    Stop();
    return false;
  }
  for (Panel& panel : panels_) {
    const auto handle = panel.surface.handle;
    overlay_->SetOverlayInputMethod(handle, vr::VROverlayInputMethod_Mouse);
    overlay_->SetOverlayFlag(handle, vr::VROverlayFlags_SendVRSmoothScrollEvents, true);
    overlay_->SetOverlayFlag(handle, vr::VROverlayFlags_EnableClickStabilization, true);
    // SteamVR draws one laser, on whichever hand last pulled its trigger. This
    // asks it to also send us the other hand's laser, so that the hand now
    // pointing at the panel can use it without the other one handing it over.
    overlay_->SetOverlayFlag(handle, vr::VROverlayFlags_MultiCursor, true);
    // The page renderer hands over premultiplied alpha, and a page's
    // background may be see-through.
    overlay_->SetOverlayFlag(handle, vr::VROverlayFlags_IsPremultiplied, true);
    overlay_->SetOverlayAlpha(handle, panel.alpha);
    // The button sits between the main panel and the ones opened from it.
    overlay_->SetOverlaySortOrder(handle, 10 + 2 * panel.index);
  }

  overlay_->SetOverlayInputMethod(button_.handle, vr::VROverlayInputMethod_Mouse);
  // The button rides on one wrist and is pressed with the other hand, whichever
  // laser that hand happens to carry.
  overlay_->SetOverlayFlag(button_.handle, vr::VROverlayFlags_MultiCursor, true);
  overlay_->SetOverlaySortOrder(button_.handle, 11);
  // The page renderer hands over premultiplied alpha; the button has a
  // transparent surround.
  overlay_->SetOverlayFlag(button_.handle, vr::VROverlayFlags_IsPremultiplied, true);
  overlay_->SetOverlayWidthInMeters(button_.handle, kButtonWidth);

  {
    std::lock_guard<std::mutex> lock(g_inbox.mutex);
    for (Picture& pic : g_inbox.panels) pic.MarkAllDirty();
    g_inbox.button.MarkAllDirty();
  }
  buttonShown_ = false;
  buttonPointing_ = {};
  for (Panel& panel : panels_) {
    panel.keyboardOpen = false;
    panel.pointing = {};
  }
  tipKnown_[0] = tipKnown_[1] = false;

  char exe[MAX_PATH];
  std::string manifest(exe, GetModuleFileNameA(nullptr, exe, MAX_PATH));
  manifest = manifest.substr(0, manifest.find_last_of("\\/") + 1) + "actions.json";
  if (input_->SetActionManifestPath(manifest.c_str()) == vr::VRInputError_None) {
    input_->GetActionSetHandle("/actions/panel", &actionSet_);
    input_->GetActionHandle("/actions/panel/in/pointer", &pointerAction_);
    input_->GetInputSourceHandle("/user/hand/left", &hands_[0]);
    input_->GetInputSourceHandle("/user/hand/right", &hands_[1]);
  } else {
    Log("SetActionManifestPath failed for %s", manifest.c_str());
  }

  for (Panel& panel : panels_) {
    if (!panel.visible) continue;
    ApplyPlacement(panel);
    overlay_->ShowOverlay(panel.surface.handle);
  }
  Emit("{\"t\":\"steamvr\",\"up\":true}");
  return true;
}

void Overlays::Stop() {
  dragging_ = nullptr;
  for (Panel& panel : panels_) panel.surface.Release();
  button_.Release();
  if (context_) { context_->Release(); context_ = nullptr; }
  if (device_) { device_->Release(); device_ = nullptr; }
  if (system_) {
    vr::VR_Shutdown();
    system_ = nullptr;
    overlay_ = nullptr;
    input_ = nullptr;
  }
}

bool Overlays::DevicePose(vr::TrackedDeviceIndex_t device, Mat* out) {
  if (device == vr::k_unTrackedDeviceIndexInvalid || device >= vr::k_unMaxTrackedDeviceCount) return false;
  vr::TrackedDevicePose_t poses[vr::k_unMaxTrackedDeviceCount];
  system_->GetDeviceToAbsoluteTrackingPose(kUniverse, 0.f, poses, vr::k_unMaxTrackedDeviceCount);
  if (!poses[device].bPoseIsValid) return false;
  *out = poses[device].mDeviceToAbsoluteTracking;
  return true;
}

// In front of the head: straight ahead on the horizontal plane, whatever the
// head's pitch, facing back at the viewer.
Mat Overlays::FrontPose() {
  Mat h;
  if (!system_ || !DevicePose(vr::k_unTrackedDeviceIndex_Hmd, &h)) {
    Mat m = Identity();
    m.m[1][3] = 1.4f;
    m.m[2][3] = -0.8f;
    return m;
  }
  float fx = -h.m[0][2], fz = -h.m[2][2];
  const float len = std::sqrt(fx * fx + fz * fz);
  if (len < 1e-3f) { fx = 0.f; fz = -1.f; } else { fx /= len; fz /= len; }

  constexpr float kDistance = 0.8f;
  constexpr float kBelowEyes = 0.15f;
  // The panel faces back at the viewer: its +Z is -forward, +Y is up.
  Mat m{};
  m.m[0][0] = -fz; m.m[0][1] = 0.f; m.m[0][2] = -fx;
  m.m[1][0] = 0.f; m.m[1][1] = 1.f; m.m[1][2] = 0.f;
  m.m[2][0] = fx;  m.m[2][1] = 0.f; m.m[2][2] = -fz;
  m.m[0][3] = h.m[0][3] + fx * kDistance;
  m.m[1][3] = h.m[1][3] - kBelowEyes;
  m.m[2][3] = h.m[2][3] + fz * kDistance;
  return m;
}

void Overlays::Recenter(Panel& panel) {
  if (!system_) return;
  panel.worldPose = FrontPose();
  panel.placed = true;
}

// To the right of the main panel, its inner edge beside the main panel's
// right edge and turned in towards the viewer. With the main panel on the
// wrist or never placed, beside where it would stand in front of the head.
void Overlays::PlaceBeside(Panel& panel) {
  if (!system_) return;
  const Panel& main = panels_[0];
  const Mat base = main.mode == 0 && main.placed ? main.worldPose : FrontPose();
  const float mainWidth = main.worldWidth;

  // The hinge: on the main panel's plane, just past its right edge.
  const float out = mainWidth / 2 + kBesideGap;
  float hinge[3];
  for (int i = 0; i < 3; ++i) hinge[i] = base.m[i][3] + base.m[i][0] * out;

  // Turned about the vertical so its face (+Z) swings towards the viewer.
  const Mat turned = Multiply(base, RotationY(-kBesideTurn));
  Mat m = turned;
  for (int i = 0; i < 3; ++i) m.m[i][3] = hinge[i] + turned.m[i][0] * (panel.worldWidth / 2);
  panel.worldPose = m;
  panel.placed = true;
}

void Overlays::ApplyPlacement(Panel& panel) {
  if (!overlay_ || dragging_ == &panel) return;
  const auto handle = panel.surface.handle;
  if (panel.mode == 1) {
    const auto left = system_->GetTrackedDeviceIndexForControllerRole(vr::TrackedControllerRole_LeftHand);
    if (left != vr::k_unTrackedDeviceIndexInvalid) {
      const Mat offset = WristOffset();
      overlay_->SetOverlayWidthInMeters(handle, panel.wristWidth);
      overlay_->SetOverlayTransformTrackedDeviceRelative(handle, left, &offset);
      return;
    }
    Log("no left controller; panel %u stays in the world", panel.index);
  }
  if (!panel.placed) {
    if (panel.index == 0) Recenter(panel);
    else PlaceBeside(panel);
  }
  overlay_->SetOverlayWidthInMeters(handle, panel.worldWidth);
  overlay_->SetOverlayTransformAbsolute(handle, kUniverse, &panel.worldPose);
}

// The page changed shape: taller or shorter at the same width. The overlay
// is placed by its centre, so left alone it would grow both ways; moved by
// half the change, its top edge stays where the viewer left it.
void Overlays::KeepTop(Panel& panel, uint32_t oldWidth, uint32_t oldHeight) {
  const Surface& s = panel.surface;
  if (oldWidth == 0 || s.width == 0 || panel.mode != 0 || !panel.placed || dragging_ == &panel) return;
  const float before = panel.worldWidth * static_cast<float>(oldHeight) / static_cast<float>(oldWidth);
  const float after = panel.worldWidth * static_cast<float>(s.height) / static_cast<float>(s.width);
  const float down = (after - before) / 2;
  for (int i = 0; i < 3; ++i) panel.worldPose.m[i][3] -= panel.worldPose.m[i][1] * down;
  ApplyPlacement(panel);
  EmitPlacement(panel);
}

void Overlays::EmitPlacement(const Panel& panel) {
  std::string json = "{\"t\":\"placement\",\"p\":" + std::to_string(panel.index) +
                     ",\"mode\":" + std::to_string(panel.mode) + ",\"m\":[";
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 4; ++j) {
      char num[32];
      snprintf(num, sizeof num, "%s%.5f", (i || j) ? "," : "", panel.worldPose.m[i][j]);
      json += num;
    }
  }
  Emit(json + "]}");
}

void Overlays::SetVisible(Panel& panel, bool visible) {
  panel.visible = visible;
  if (!overlay_) return;
  if (visible) {
    ApplyPlacement(panel);
    overlay_->ShowOverlay(panel.surface.handle);
  } else {
    if (dragging_ == &panel) EndDrag();
    if (panel.keyboardOpen) {
      panel.keyboardOpen = false;
      overlay_->HideKeyboard();
    }
    overlay_->HideOverlay(panel.surface.handle);
  }
}

void Overlays::SetMode(Panel& panel, uint32_t mode) {
  if (mode > 1 || mode == panel.mode) return;
  if (dragging_ == &panel) EndDrag();
  panel.mode = mode;
  // Taken off the wrist, the panel comes back in front of the viewer rather
  // than wherever it was left before.
  if (panel.mode == 0) Recenter(panel);
  ApplyPlacement(panel);
  EmitPlacement(panel);
}

// Carrying a panel: it is attached to the controller holding it, so the
// compositor moves it with the hand at full frame rate.
void Overlays::StartDrag(Panel& panel, vr::TrackedDeviceIndex_t device) {
  if (!overlay_ || !panel.visible || panel.mode != 0 || dragging_) return;
  Mat pose;
  if (!DevicePose(device, &pose)) return;
  dragDevice_ = device;
  dragOffset_ = Multiply(InvertRigid(pose), panel.worldPose);
  dragging_ = &panel;
  overlay_->SetOverlayTransformTrackedDeviceRelative(panel.surface.handle, dragDevice_, &dragOffset_);
  Emit("{\"t\":\"grab\",\"p\":" + std::to_string(panel.index) + ",\"held\":true}");
}

void Overlays::EndDrag() {
  Panel* panel = dragging_;
  if (!panel) return;
  dragging_ = nullptr;
  Mat pose;
  if (DevicePose(dragDevice_, &pose)) {
    panel->worldPose = Multiply(pose, dragOffset_);
    panel->placed = true;
  }
  ApplyPlacement(*panel);
  EmitPlacement(*panel);
  Emit("{\"t\":\"grab\",\"p\":" + std::to_string(panel->index) + ",\"held\":false}");
}

void Overlays::HandleCommand(uint32_t message, const std::vector<uint8_t>& payload) {
  const uint32_t type = message & 0xffff;
  Panel& panel = panels_[std::min(message >> 16, kPanelCount - 1)];
  auto u32 = [&](size_t at) -> uint32_t {
    uint32_t v = 0;
    if (payload.size() >= at + 4) memcpy(&v, payload.data() + at, 4);
    return v;
  };
  switch (type) {
    case kShow: SetVisible(panel, true); break;
    case kHide: SetVisible(panel, false); break;
    case kMode: SetMode(panel, u32(0)); break;
    case kRecenter:
      // From the wrist this also takes the panel off it: in front of the
      // viewer is always in the world. A panel opened from the main one comes
      // back beside it instead.
      if (!overlay_) break;
      if (panel.mode == 1) {
        SetMode(panel, 0);
        Emit("{\"t\":\"mode\",\"p\":" + std::to_string(panel.index) + ",\"mode\":0}");
      } else {
        if (panel.index == 0) Recenter(panel);
        else PlaceBeside(panel);
        ApplyPlacement(panel);
        EmitPlacement(panel);
      }
      break;
    case kKeyboard: {
      if (!overlay_) break;
      const bool open = u32(0) != 0;
      // SteamVR has one keyboard; opening it for this panel takes it from
      // any other.
      for (Panel& other : panels_) other.keyboardOpen = false;
      panel.keyboardOpen = open;
      if (open) {
        const std::string text(payload.begin() + std::min<size_t>(4, payload.size()), payload.end());
        overlay_->ShowKeyboardForOverlay(panel.surface.handle, vr::k_EGamepadTextInputModeNormal,
                                         vr::k_EGamepadTextInputLineModeSingleLine,
                                         vr::KeyboardFlag_Minimal, "", 256, text.c_str(), 0);
      } else {
        overlay_->HideKeyboard();
      }
      break;
    }
    case kPlacement:
      if (payload.size() >= 48) {
        memcpy(&panel.worldPose, payload.data(), 48);
        panel.placed = true;
        ApplyPlacement(panel);
      }
      break;
    case kAlpha:
      if (payload.size() >= 4) {
        float a;
        memcpy(&a, payload.data(), 4);
        panel.alpha = std::min(1.f, std::max(0.05f, a));
        if (overlay_) overlay_->SetOverlayAlpha(panel.surface.handle, panel.alpha);
      }
      break;
    case kSize:
      if (payload.size() >= 8) {
        float w[2];
        memcpy(w, payload.data(), 8);
        if (w[0] > 0.1f && w[0] < 5.f) panel.worldWidth = w[0];
        if (w[1] > 0.05f && w[1] < 1.f) panel.wristWidth = w[1];
        ApplyPlacement(panel);
      }
      break;
    default:
      Log("unknown message type %u", type);
  }
}

const char* HandName(vr::IVRSystem* system, vr::TrackedDeviceIndex_t device) {
  switch (system->GetControllerRoleForTrackedDeviceIndex(device)) {
    case vr::TrackedControllerRole_LeftHand: return "left";
    case vr::TrackedControllerRole_RightHand: return "right";
    default: return "other";
  }
}

uint32_t ThisCursor(uint32_t index) { return index < kCursorCount ? index : 0; }
uint32_t OtherCursor(uint32_t cursor) { return cursor ^ 1u; }

// Hands the page's pointer to another laser.
void TakePointer(Panel& panel, uint32_t cursor, vr::IVRSystem* system, const char* why) {
  panel.pointerCursor = cursor;
  panel.holding = false;
  for (Laser& laser : panel.lasers) laser.travelled = 0;
  Log("panel %u follows the %s hand now (cursor %u, it %s)", panel.index,
      HandName(system, panel.lasers[cursor].device), cursor, why);
}

// One pointer event for the page. Overlay mouse coordinates start at the
// bottom left, the page's at the top left.
void EmitPointer(const Panel& panel, const char* kind, uint32_t cursor, uint32_t button) {
  const Laser& laser = panel.lasers[cursor];
  char json[256];
  snprintf(json, sizeof json, "{\"t\":\"%s\",\"p\":%u,\"x\":%.1f,\"y\":%.1f,\"button\":%u}", kind, panel.index,
           laser.x, static_cast<float>(panel.surface.height) - laser.y, button);
  Emit(json);
}

void Overlays::PollPanelEvents(Panel& panel) {
  const unsigned p = panel.index;
  vr::VREvent_t ev;
  while (overlay_->PollNextOverlayEvent(panel.surface.handle, &ev, sizeof ev)) {
    char json[256];
    switch (ev.eventType) {
      case vr::VREvent_FocusEnter: {
        const uint32_t c = ThisCursor(ev.data.overlay.cursorIndex);
        panel.lasers[c] = Laser{};
        panel.lasers[c].onPanel = true;
        panel.lasers[c].device = ev.trackedDeviceIndex;
        // The pointer goes to the only laser on the panel without asking for
        // any more movement.
        if (!panel.lasers[OtherCursor(c)].onPanel) {
          panel.pointerCursor = c;
          panel.holding = false;
        }
        break;
      }
      case vr::VREvent_FocusLeave: {
        const uint32_t c = ThisCursor(ev.data.overlay.cursorIndex);
        const uint32_t other = OtherCursor(c);
        Log("laser off panel %u (device %u, cursor %u)", p, ev.trackedDeviceIndex, c);
        if (c != panel.pointerCursor) {
          panel.lasers[c] = Laser{};
          break;
        }
        if (panel.holding) {
          // Whatever the page was being dragged with, the hand doing it is
          // gone; let go of it where it stood.
          panel.holding = false;
          EmitPointer(panel, "up", c, vr::VRMouseButton_Left);
        }
        panel.lasers[c] = Laser{};
        if (panel.lasers[other].onPanel) {
          // The hand still pointing takes the pointer where it already is, so
          // the page sees it move rather than leave.
          TakePointer(panel, other, system_, "is the one left pointing");
          if (panel.lasers[other].placed) EmitPointer(panel, "move", other, 0);
          break;
        }
        snprintf(json, sizeof json, "{\"t\":\"leave\",\"p\":%u}", p);
        Emit(json);
        break;
      }
      case vr::VREvent_MouseButtonDown:
      case vr::VREvent_MouseButtonUp:
        // While a panel is up SteamVR's laser owns the controllers, and the
        // grip reaches us only as the laser's middle button, from the
        // controller the laser comes from. That controller carries the panel.
        if (ev.data.mouse.button == vr::VRMouseButton_Middle) {
          Log("grip %s on panel %u (device %u, %s hand, cursor %u)",
              ev.eventType == vr::VREvent_MouseButtonDown ? "down" : "up", p, ev.trackedDeviceIndex,
              HandName(system_, ev.trackedDeviceIndex), ev.data.mouse.cursorIndex);
          if (ev.eventType == vr::VREvent_MouseButtonDown) {
            StartDrag(panel, ev.trackedDeviceIndex);
          } else if (dragging_ == &panel && ev.trackedDeviceIndex == dragDevice_) {
            EndDrag();
          }
          break;
        }
        [[fallthrough]];
      case vr::VREvent_MouseMove: {
        const uint32_t c = ThisCursor(ev.data.mouse.cursorIndex);
        Laser& laser = panel.lasers[c];
        const float moved =
            laser.placed ? std::sqrt((ev.data.mouse.x - laser.x) * (ev.data.mouse.x - laser.x) +
                                     (ev.data.mouse.y - laser.y) * (ev.data.mouse.y - laser.y))
                         : 0.f;
        laser.x = ev.data.mouse.x;
        laser.y = ev.data.mouse.y;
        laser.placed = true;
        laser.onPanel = true;
        laser.device = ev.trackedDeviceIndex;

        if (ev.eventType == vr::VREvent_MouseMove) {
          if (c == panel.pointerCursor) {
            // Moving the pointer spends what the other hand has built up, so
            // a resting hand's wobble never wins it.
            if (moved > kLaserNoise) {
              Laser& other = panel.lasers[OtherCursor(c)];
              other.travelled = std::max(0.f, other.travelled - moved);
            }
          } else if (!panel.holding && moved > kLaserNoise) {
            laser.travelled += moved;
            if (laser.travelled > kLaserTakeOver) TakePointer(panel, c, system_, "is the hand that is moving");
          }
          if (c != panel.pointerCursor) break;
        } else {
          // Pressing says plainly which hand is being used, so it takes the
          // pointer at once — unless the hand that has it is mid-click or
          // part way through dragging something. A release on its own is no
          // such statement: it belongs to a press the page never saw.
          if (c != panel.pointerCursor && !panel.holding && ev.eventType == vr::VREvent_MouseButtonDown) {
            TakePointer(panel, c, system_, "clicked");
            // The page follows the new hand before it is clicked there.
            EmitPointer(panel, "move", c, 0);
          }
          if (c != panel.pointerCursor) break;
          if (ev.data.mouse.button == vr::VRMouseButton_Left) {
            panel.holding = ev.eventType == vr::VREvent_MouseButtonDown;
          }
        }
        if (panel.logNextMove) {
          panel.logNextMove = false;
          Log("  SteamVR's laser lands at %.3f, %.3f", laser.x / std::max(1u, panel.surface.width),
              laser.y / std::max(1u, panel.surface.height));
        }
        EmitPointer(panel, ev.eventType == vr::VREvent_MouseMove ? "move"
                           : ev.eventType == vr::VREvent_MouseButtonDown ? "down"
                                                                        : "up",
                    c, ev.data.mouse.button);
        break;
      }
      case vr::VREvent_ScrollSmooth:
      case vr::VREvent_ScrollDiscrete: {
        // A scroll is as deliberate as a click, and the page scrolls whatever
        // its pointer rests on, so the scrolling hand takes the pointer first.
        const uint32_t c = ThisCursor(ev.data.scroll.cursorIndex);
        if (c != panel.pointerCursor) {
          if (panel.holding) break;
          TakePointer(panel, c, system_, "scrolled");
          if (panel.lasers[c].placed) EmitPointer(panel, "move", c, 0);
        }
        snprintf(json, sizeof json, "{\"t\":\"scroll\",\"p\":%u,\"dx\":%.4f,\"dy\":%.4f}", p,
                 ev.data.scroll.xdelta, ev.data.scroll.ydelta);
        Emit(json);
        break;
      }
      case vr::VREvent_KeyboardCharInput: {
        char text[9] = {};
        memcpy(text, ev.data.keyboard.cNewInput, 8);
        Emit("{\"t\":\"key\",\"p\":" + std::to_string(p) + ",\"s\":" + JsonString(text) + "}");
        break;
      }
      case vr::VREvent_KeyboardDone:
        panel.keyboardOpen = false;
        snprintf(json, sizeof json, "{\"t\":\"keyboard\",\"p\":%u,\"done\":true}", p);
        Emit(json);
        break;
      case vr::VREvent_KeyboardClosed:
        panel.keyboardOpen = false;
        snprintf(json, sizeof json, "{\"t\":\"keyboard\",\"p\":%u,\"done\":false}", p);
        Emit(json);
        break;
      case vr::VREvent_OverlayShown:
        snprintf(json, sizeof json, "{\"t\":\"visible\",\"p\":%u,\"v\":true}", p);
        Emit(json);
        break;
      case vr::VREvent_OverlayHidden:
        snprintf(json, sizeof json, "{\"t\":\"visible\",\"p\":%u,\"v\":false}", p);
        Emit(json);
        break;
      default:
        break;
    }
  }
}

void Overlays::PollButtonEvents() {
  vr::VREvent_t ev;
  while (overlay_->PollNextOverlayEvent(button_.handle, &ev, sizeof ev)) {
    if (ev.eventType == vr::VREvent_MouseButtonDown && ev.data.mouse.button == vr::VRMouseButton_Left) {
      Log("summon pressed (device %u, %s hand)", ev.trackedDeviceIndex, HandName(system_, ev.trackedDeviceIndex));
      overlay_->HideOverlay(button_.handle);
      buttonShown_ = false;
      SetVisible(panels_[0], true);
      Emit("{\"t\":\"summon\"}");
    }
  }
}

// The button shows while the main panel is away and the back of the right
// hand is turned to the eyes.
void Overlays::UpdateButton() {
  if (!button_.texture) return;
  bool want = false;
  const auto right = system_->GetTrackedDeviceIndexForControllerRole(vr::TrackedControllerRole_RightHand);
  Mat hand, head;
  if (!panels_[0].visible && DevicePose(right, &hand) && DevicePose(vr::k_unTrackedDeviceIndex_Hmd, &head)) {
    float to[3] = {head.m[0][3] - hand.m[0][3], head.m[1][3] - hand.m[1][3], head.m[2][3] - hand.m[2][3]};
    const float len = std::sqrt(to[0] * to[0] + to[1] * to[1] + to[2] * to[2]);
    if (len > 1e-3f) {
      for (float& v : to) v /= len;
      // Each controller axis against the direction to the eyes. The back of
      // the hand is taken as +X; all six are logged so that can be checked.
      float along[3];
      for (int axis = 0; axis < 3; ++axis) {
        along[axis] = hand.m[0][axis] * to[0] + hand.m[1][axis] * to[1] + hand.m[2][axis] * to[2];
      }
      const float facing = along[0];
      want = buttonShown_ ? facing > kFacingHide : facing > kFacingShow;

      const double now = NowMs();
      if (now >= nextFacingLog_) {
        nextFacingLog_ = now + 1000;
        Log("right hand towards the eyes: +X %.2f  +Y %.2f  +Z %.2f (button %s)", along[0], along[1], along[2],
            want ? "shown" : "hidden");
      }
    }
  }
  if (want == buttonShown_) return;
  buttonShown_ = want;
  if (want) {
    const Mat offset = ButtonOffset();
    overlay_->SetOverlayTransformTrackedDeviceRelative(button_.handle, right, &offset);
    overlay_->ShowOverlay(button_.handle);
  } else {
    overlay_->HideOverlay(button_.handle);
  }
}

bool Overlays::PointerRay(int hand, Mat* ray) {
  const vr::ETrackedControllerRole role =
      hand ? vr::TrackedControllerRole_RightHand : vr::TrackedControllerRole_LeftHand;
  Mat raw;
  if (!DevicePose(system_->GetTrackedDeviceIndexForControllerRole(role), &raw)) return false;

  vr::InputPoseActionData_t tip{};
  if (pointerAction_ != vr::k_ulInvalidActionHandle &&
      input_->GetPoseActionDataForNextFrame(pointerAction_, kUniverse, &tip, sizeof tip, hands_[hand]) ==
          vr::VRInputError_None &&
      tip.bActive && tip.pose.bPoseIsValid) {
    tipOffset_[hand] = Multiply(InvertRigid(raw), tip.pose.mDeviceToAbsoluteTracking);
    tipKnown_[hand] = true;
  }
  *ray = tipKnown_[hand] ? Multiply(raw, tipOffset_[hand]) : raw;
  return true;
}

// Hands the controllers to `surface` while a laser points at it (or `hold`
// says it must keep them), and back to the app underneath otherwise.
void Overlays::UpdatePointing(Surface& surface, Pointing& pointing, bool shown, bool hold, const char* name,
                              bool* logMove) {
  const double now = NowMs();
  bool hit = false;
  int hitHand = -1;
  vr::HmdVector2_t hitUv{};
  if (shown && surface.texture) {
    for (int hand = 0; hand < 2 && !hit; ++hand) {
      Mat ray;
      if (!PointerRay(hand, &ray)) continue;
      vr::VROverlayIntersectionParams_t params{};
      params.vSource = {ray.m[0][3], ray.m[1][3], ray.m[2][3]};
      params.vDirection = {-ray.m[0][2], -ray.m[1][2], -ray.m[2][2]};
      params.eOrigin = kUniverse;
      vr::VROverlayIntersectionResults_t result{};
      if (overlay_->ComputeOverlayIntersection(surface.handle, &params, &result)) {
        hit = true;
        hitHand = hand;
        hitUv = result.vUVs;
      }
    }
  }
  if (hit) pointing.lastHit = now;

  const bool want = shown && (hold || hit || (pointing.interactive && now - pointing.lastHit < kPointingLingerMs));
  if (want == pointing.interactive) return;
  pointing.interactive = want;
  overlay_->SetOverlayFlag(surface.handle, vr::VROverlayFlags_MakeOverlaysInteractiveIfVisible, want);
  if (want && hit) {
    const auto primary = overlay_->GetPrimaryDashboardDevice();
    Log("%s takes the controllers: %s tip points at %.3f, %.3f; SteamVR's laser is on device %u (%s hand)", name,
        hitHand ? "right" : "left", hitUv.v[0], hitUv.v[1], primary, HandName(system_, primary));
    if (logMove) *logMove = true;
  } else {
    Log("%s %s the controllers", name, want ? "takes" : "releases");
  }
}

bool Overlays::Tick() {
  vr::VREvent_t ev;
  while (system_->PollNextEvent(&ev, sizeof ev)) {
    if (ev.eventType == vr::VREvent_Quit) {
      system_->AcknowledgeQuit_Exiting();
      return false;
    }
    if (ev.eventType == vr::VREvent_PrimaryDashboardDeviceChanged) {
      const auto primary = overlay_->GetPrimaryDashboardDevice();
      Log("SteamVR's laser moves to device %u (%s hand)", primary, HandName(system_, primary));
    }
  }
  for (Panel& panel : panels_) PollPanelEvents(panel);
  PollButtonEvents();
  uint32_t oldSize[kPanelCount][2];
  for (const Panel& panel : panels_) {
    oldSize[panel.index][0] = panel.surface.width;
    oldSize[panel.index][1] = panel.surface.height;
  }
  {
    std::lock_guard<std::mutex> lock(g_inbox.mutex);
    for (Panel& panel : panels_) Upload(panel.surface, g_inbox.panels[panel.index], true);
    Upload(button_, g_inbox.button, false);
  }
  for (Panel& panel : panels_) {
    const uint32_t w = oldSize[panel.index][0], h = oldSize[panel.index][1];
    if (panel.surface.width != w || panel.surface.height != h) KeepTop(panel, w, h);
  }
  UpdateButton();

  if (actionSet_ != vr::k_ulInvalidActionSetHandle) {
    vr::VRActiveActionSet_t active{};
    active.ulActionSet = actionSet_;
    input_->UpdateActionState(&active, sizeof active, 1);
  }
  for (Panel& panel : panels_) {
    char name[16];
    snprintf(name, sizeof name, "panel %u", panel.index);
    UpdatePointing(panel.surface, panel.pointing, panel.visible, dragging_ == &panel || panel.keyboardOpen, name,
                   &panel.logNextMove);
    if (!panel.pointing.interactive) {
      // No laser reaches the panel, so nothing is known about where they are
      // until one arrives again.
      for (Laser& laser : panel.lasers) laser = Laser{};
      panel.holding = false;
    }
  }
  UpdatePointing(button_, buttonPointing_, buttonShown_, false, "button", nullptr);
  return true;
}

// Probe for a running SteamVR without starting one.
bool SteamVrRunning() {
  vr::EVRInitError error = vr::VRInitError_None;
  vr::VR_Init(&error, vr::VRApplication_Background);
  if (error != vr::VRInitError_None) return false;
  vr::VR_Shutdown();
  return true;
}

void DrainCommands(Overlays& overlays) {
  std::deque<std::pair<uint32_t, std::vector<uint8_t>>> commands;
  {
    std::lock_guard<std::mutex> lock(g_inbox.mutex);
    commands.swap(g_inbox.commands);
  }
  for (auto& c : commands) overlays.HandleCommand(c.first, c.second);
}

}  // namespace

int main() {
  std::thread reader(ReadStdin);
  reader.detach();

  Overlays overlays;
  Emit("{\"t\":\"hello\"}");
  bool reportedDown = false;

  while (!g_inbox.closed) {
    if (!SteamVrRunning()) {
      if (!reportedDown) { Emit("{\"t\":\"steamvr\",\"up\":false}"); reportedDown = true; }
      // Messages still count while SteamVR is away: placement and size are
      // kept for when it comes back.
      for (int i = 0; i < 20 && !g_inbox.closed; ++i) {
        DrainCommands(overlays);
        Sleep(100);
      }
      continue;
    }
    if (!overlays.Start()) {
      Sleep(2000);
      continue;
    }
    reportedDown = false;

    while (!g_inbox.closed) {
      DrainCommands(overlays);
      if (!overlays.Tick()) break;
      // Controller input is polled, so the loop also wakes on its own at
      // about the headset's frame rate.
      WaitForSingleObject(g_inboxSignal, 11);
    }
    overlays.Stop();
    Emit("{\"t\":\"steamvr\",\"up\":false}");
    reportedDown = true;
  }
  overlays.Stop();
  return 0;
}
