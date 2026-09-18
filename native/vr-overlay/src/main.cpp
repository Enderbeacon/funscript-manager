// vr-overlay: puts the app's VR panel into SteamVR as an overlay.
//
// The panel itself is a web page the app renders off screen. This process only
// owns the SteamVR side: it shows the pixels it is given on a floating panel,
// places the panel in the world or on the left wrist, lets the viewer grab and
// carry it, offers a button on the right wrist that brings it back, and reports
// what the controllers do on it.
//
// stdin, from the app — binary messages, little endian:
//   u32 type, u32 length, then `length` bytes of payload.
// stdout, to the app — one JSON object per line.
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
  kRecenter = 5,     // put the panel in front of the head
  kKeyboard = 6,     // u32 open; then UTF-8 text already in the field
  kPlacement = 8,    // float[12]: where the panel stood last time (row-major 3x4)
  kSize = 9,         // float world width, float wrist width, in metres
  kButtonImage = 10, // u32 w, h; then w*h*4 bytes BGRA: the wrist button
};

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
  Picture panel;
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

    if (header[0] == kFrame) {
      if (payload.size() < 24) continue;
      uint32_t f[6];
      memcpy(f, payload.data(), sizeof f);
      if (!ValidRect(f[0], f[1], f[2], f[3], f[4], f[5], payload.size() - 24)) continue;
      std::lock_guard<std::mutex> lock(g_inbox.mutex);
      Paint(g_inbox.panel, f[0], f[1], f[2], f[3], f[4], f[5], payload.data() + 24);
    } else if (header[0] == kButtonImage) {
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

constexpr char kPanelKey[] = "funscript-manager.panel";
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

class Panel {
 public:
  bool Start();
  void Stop();
  // False once SteamVR has gone away.
  bool Tick();

  void HandleCommand(uint32_t type, const std::vector<uint8_t>& payload);

 private:
  bool CreateDevice();
  bool Upload(Surface& surface, Picture& pic, bool mouseScale);
  void SetVisible(bool visible);
  void Recenter();
  void SetMode(uint32_t mode);
  void StartDrag(vr::TrackedDeviceIndex_t device);
  void EndDrag();
  void ApplyPlacement();
  void EmitPlacement();
  void PollPanelEvents();
  void PollButtonEvents();
  void UpdateButton();
  bool PointerRay(int hand, Mat* ray);
  void UpdatePointing(Surface& surface, struct Pointing& pointing, bool shown, bool hold, const char* name);
  bool DevicePose(vr::TrackedDeviceIndex_t device, Mat* out);

  vr::IVRSystem* system_ = nullptr;
  vr::IVROverlay* overlay_ = nullptr;

  ID3D11Device* device_ = nullptr;
  ID3D11DeviceContext* context_ = nullptr;
  Surface panel_;
  Surface button_;

  uint32_t mode_ = 0;
  bool placed_ = false;  // world placement known (restored, recentred or carried)
  Mat worldPose_ = Identity();
  float worldWidth_ = 0.9f;
  float wristWidth_ = 0.32f;
  bool visible_ = false;

  // The controller the laser on the panel comes from, for the log.
  vr::TrackedDeviceIndex_t laserDevice_ = vr::k_unTrackedDeviceIndexInvalid;

  bool dragging_ = false;
  vr::TrackedDeviceIndex_t dragDevice_ = vr::k_unTrackedDeviceIndexInvalid;
  Mat dragOffset_ = Identity();

  bool buttonShown_ = false;
  bool keyboardOpen_ = false;

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

  Pointing panelPointing_;
  Pointing buttonPointing_;
  bool logNextPanelMove_ = false;
  double nextFacingLog_ = 0;
};

double NowMs() {
  static LARGE_INTEGER freq = [] { LARGE_INTEGER f; QueryPerformanceFrequency(&f); return f; }();
  LARGE_INTEGER now;
  QueryPerformanceCounter(&now);
  return 1000.0 * static_cast<double>(now.QuadPart) / static_cast<double>(freq.QuadPart);
}

bool Panel::CreateDevice() {
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
bool Panel::Upload(Surface& surface, Picture& pic, bool mouseScale) {
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

bool Panel::Start() {
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
  if (overlay_->CreateOverlay(kPanelKey, kOverlayName, &panel_.handle) != vr::VROverlayError_None ||
      overlay_->CreateOverlay(kButtonKey, kOverlayName, &button_.handle) != vr::VROverlayError_None) {
    Log("CreateOverlay failed");
    Stop();
    return false;
  }
  overlay_->SetOverlayInputMethod(panel_.handle, vr::VROverlayInputMethod_Mouse);
  overlay_->SetOverlayFlag(panel_.handle, vr::VROverlayFlags_SendVRSmoothScrollEvents, true);
  overlay_->SetOverlayFlag(panel_.handle, vr::VROverlayFlags_EnableClickStabilization, true);
  overlay_->SetOverlaySortOrder(panel_.handle, 10);

  overlay_->SetOverlayInputMethod(button_.handle, vr::VROverlayInputMethod_Mouse);
  overlay_->SetOverlaySortOrder(button_.handle, 11);
  // The page renderer hands over premultiplied alpha; the button has a
  // transparent surround.
  overlay_->SetOverlayFlag(button_.handle, vr::VROverlayFlags_IsPremultiplied, true);
  overlay_->SetOverlayWidthInMeters(button_.handle, kButtonWidth);

  {
    std::lock_guard<std::mutex> lock(g_inbox.mutex);
    g_inbox.panel.MarkAllDirty();
    g_inbox.button.MarkAllDirty();
  }
  buttonShown_ = false;
  keyboardOpen_ = false;
  panelPointing_ = {};
  buttonPointing_ = {};
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

  ApplyPlacement();
  if (visible_) overlay_->ShowOverlay(panel_.handle);
  Emit("{\"t\":\"steamvr\",\"up\":true}");
  return true;
}

void Panel::Stop() {
  dragging_ = false;
  panel_.Release();
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

bool Panel::DevicePose(vr::TrackedDeviceIndex_t device, Mat* out) {
  if (device == vr::k_unTrackedDeviceIndexInvalid || device >= vr::k_unMaxTrackedDeviceCount) return false;
  vr::TrackedDevicePose_t poses[vr::k_unMaxTrackedDeviceCount];
  system_->GetDeviceToAbsoluteTrackingPose(kUniverse, 0.f, poses, vr::k_unMaxTrackedDeviceCount);
  if (!poses[device].bPoseIsValid) return false;
  *out = poses[device].mDeviceToAbsoluteTracking;
  return true;
}

void Panel::Recenter() {
  if (!system_) return;
  Mat h;
  if (!DevicePose(vr::k_unTrackedDeviceIndex_Hmd, &h)) return;

  // Straight ahead on the horizontal plane, whatever the head's pitch.
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
  worldPose_ = m;
  placed_ = true;
}

void Panel::ApplyPlacement() {
  if (!overlay_ || dragging_) return;
  if (mode_ == 1) {
    const auto left = system_->GetTrackedDeviceIndexForControllerRole(vr::TrackedControllerRole_LeftHand);
    if (left != vr::k_unTrackedDeviceIndexInvalid) {
      const Mat offset = WristOffset();
      overlay_->SetOverlayWidthInMeters(panel_.handle, wristWidth_);
      overlay_->SetOverlayTransformTrackedDeviceRelative(panel_.handle, left, &offset);
      return;
    }
    Log("no left controller; the panel stays in the world");
  }
  if (!placed_) Recenter();
  overlay_->SetOverlayWidthInMeters(panel_.handle, worldWidth_);
  overlay_->SetOverlayTransformAbsolute(panel_.handle, kUniverse, &worldPose_);
}

void Panel::EmitPlacement() {
  std::string json = "{\"t\":\"placement\",\"mode\":" + std::to_string(mode_) + ",\"m\":[";
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 4; ++j) {
      char num[32];
      snprintf(num, sizeof num, "%s%.5f", (i || j) ? "," : "", worldPose_.m[i][j]);
      json += num;
    }
  }
  Emit(json + "]}");
}

void Panel::SetVisible(bool visible) {
  visible_ = visible;
  if (!overlay_) return;
  if (visible) {
    ApplyPlacement();
    overlay_->ShowOverlay(panel_.handle);
  } else {
    if (dragging_) EndDrag();
    overlay_->HideOverlay(panel_.handle);
  }
}

void Panel::SetMode(uint32_t mode) {
  if (mode > 1 || mode == mode_) return;
  if (dragging_) EndDrag();
  mode_ = mode;
  // Taken off the wrist, the panel comes back in front of the viewer rather
  // than wherever it was left before.
  if (mode_ == 0) Recenter();
  ApplyPlacement();
  EmitPlacement();
}

// Carrying the panel: it is attached to the controller holding it, so the
// compositor moves it with the hand at full frame rate.
void Panel::StartDrag(vr::TrackedDeviceIndex_t device) {
  if (!overlay_ || !visible_ || mode_ != 0 || dragging_) return;
  Mat pose;
  if (!DevicePose(device, &pose)) return;
  dragDevice_ = device;
  dragOffset_ = Multiply(InvertRigid(pose), worldPose_);
  dragging_ = true;
  overlay_->SetOverlayTransformTrackedDeviceRelative(panel_.handle, dragDevice_, &dragOffset_);
  Emit("{\"t\":\"grab\",\"held\":true}");
}

void Panel::EndDrag() {
  if (!dragging_) return;
  dragging_ = false;
  Mat pose;
  if (DevicePose(dragDevice_, &pose)) {
    worldPose_ = Multiply(pose, dragOffset_);
    placed_ = true;
  }
  ApplyPlacement();
  EmitPlacement();
  Emit("{\"t\":\"grab\",\"held\":false}");
}

void Panel::HandleCommand(uint32_t type, const std::vector<uint8_t>& payload) {
  auto u32 = [&](size_t at) -> uint32_t {
    uint32_t v = 0;
    if (payload.size() >= at + 4) memcpy(&v, payload.data() + at, 4);
    return v;
  };
  switch (type) {
    case kShow: SetVisible(true); break;
    case kHide: SetVisible(false); break;
    case kMode: SetMode(u32(0)); break;
    case kRecenter:
      // From the wrist this also takes the panel off it: in front of the
      // viewer is always in the world.
      if (!overlay_) break;
      if (mode_ == 1) {
        SetMode(0);
        Emit("{\"t\":\"mode\",\"mode\":0}");
      } else {
        Recenter();
        ApplyPlacement();
        EmitPlacement();
      }
      break;
    case kKeyboard:
      if (!overlay_) break;
      keyboardOpen_ = u32(0) != 0;
      if (keyboardOpen_) {
        const std::string text(payload.begin() + std::min<size_t>(4, payload.size()), payload.end());
        overlay_->ShowKeyboardForOverlay(panel_.handle, vr::k_EGamepadTextInputModeNormal,
                                         vr::k_EGamepadTextInputLineModeSingleLine,
                                         vr::KeyboardFlag_Minimal, "", 256, text.c_str(), 0);
      } else {
        overlay_->HideKeyboard();
      }
      break;
    case kPlacement:
      if (payload.size() >= 48) {
        memcpy(&worldPose_, payload.data(), 48);
        placed_ = true;
        ApplyPlacement();
      }
      break;
    case kSize:
      if (payload.size() >= 8) {
        float w[2];
        memcpy(w, payload.data(), 8);
        if (w[0] > 0.1f && w[0] < 5.f) worldWidth_ = w[0];
        if (w[1] > 0.05f && w[1] < 1.f) wristWidth_ = w[1];
        ApplyPlacement();
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

void Panel::PollPanelEvents() {
  vr::VREvent_t ev;
  while (overlay_->PollNextOverlayEvent(panel_.handle, &ev, sizeof ev)) {
    char json[256];
    switch (ev.eventType) {
      case vr::VREvent_FocusEnter:
        Log("laser on the panel (device %u, %s hand)", ev.trackedDeviceIndex, HandName(system_, ev.trackedDeviceIndex));
        break;
      case vr::VREvent_FocusLeave:
        Log("laser off the panel");
        Emit("{\"t\":\"leave\"}");
        break;
      case vr::VREvent_MouseButtonDown:
      case vr::VREvent_MouseButtonUp:
        // While the panel is up SteamVR's laser owns the controllers, and the
        // grip reaches us only as the laser's middle button, from the
        // controller the laser comes from. That controller carries the panel.
        if (ev.data.mouse.button == vr::VRMouseButton_Middle) {
          Log("grip %s on the panel (device %u, %s hand)",
              ev.eventType == vr::VREvent_MouseButtonDown ? "down" : "up", ev.trackedDeviceIndex,
              HandName(system_, ev.trackedDeviceIndex));
          if (ev.eventType == vr::VREvent_MouseButtonDown) {
            StartDrag(ev.trackedDeviceIndex);
          } else if (dragging_ && ev.trackedDeviceIndex == dragDevice_) {
            EndDrag();
          }
          break;
        }
        [[fallthrough]];
      case vr::VREvent_MouseMove: {
        if (ev.trackedDeviceIndex != laserDevice_) {
          Log("laser now from device %u (%s hand)", ev.trackedDeviceIndex, HandName(system_, ev.trackedDeviceIndex));
        }
        laserDevice_ = ev.trackedDeviceIndex;
        if (logNextPanelMove_) {
          logNextPanelMove_ = false;
          Log("  SteamVR's laser lands at %.3f, %.3f", ev.data.mouse.x / std::max(1u, panel_.width),
              ev.data.mouse.y / std::max(1u, panel_.height));
        }
        const char* kind = ev.eventType == vr::VREvent_MouseMove ? "move"
                         : ev.eventType == vr::VREvent_MouseButtonDown ? "down" : "up";
        // Overlay mouse coordinates start at the bottom left.
        snprintf(json, sizeof json, "{\"t\":\"%s\",\"x\":%.1f,\"y\":%.1f,\"button\":%u}", kind,
                 ev.data.mouse.x, static_cast<float>(panel_.height) - ev.data.mouse.y, ev.data.mouse.button);
        Emit(json);
        break;
      }
      case vr::VREvent_ScrollSmooth:
      case vr::VREvent_ScrollDiscrete:
        snprintf(json, sizeof json, "{\"t\":\"scroll\",\"dx\":%.4f,\"dy\":%.4f}",
                 ev.data.scroll.xdelta, ev.data.scroll.ydelta);
        Emit(json);
        break;
      case vr::VREvent_KeyboardCharInput: {
        char text[9] = {};
        memcpy(text, ev.data.keyboard.cNewInput, 8);
        Emit("{\"t\":\"key\",\"s\":" + JsonString(text) + "}");
        break;
      }
      case vr::VREvent_KeyboardDone:
        keyboardOpen_ = false;
        Emit("{\"t\":\"keyboard\",\"done\":true}");
        break;
      case vr::VREvent_KeyboardClosed:
        keyboardOpen_ = false;
        Emit("{\"t\":\"keyboard\",\"done\":false}");
        break;
      case vr::VREvent_OverlayShown:
        Emit("{\"t\":\"visible\",\"v\":true}");
        break;
      case vr::VREvent_OverlayHidden:
        Emit("{\"t\":\"visible\",\"v\":false}");
        break;
      default:
        break;
    }
  }
}

void Panel::PollButtonEvents() {
  vr::VREvent_t ev;
  while (overlay_->PollNextOverlayEvent(button_.handle, &ev, sizeof ev)) {
    if (ev.eventType == vr::VREvent_MouseButtonDown && ev.data.mouse.button == vr::VRMouseButton_Left) {
      Log("summon pressed (device %u, %s hand)", ev.trackedDeviceIndex, HandName(system_, ev.trackedDeviceIndex));
      overlay_->HideOverlay(button_.handle);
      buttonShown_ = false;
      SetVisible(true);
      Emit("{\"t\":\"summon\"}");
    }
  }
}

// The button shows while the panel is away and the back of the right hand is
// turned to the eyes.
void Panel::UpdateButton() {
  if (!button_.texture) return;
  bool want = false;
  const auto right = system_->GetTrackedDeviceIndexForControllerRole(vr::TrackedControllerRole_RightHand);
  Mat hand, head;
  if (!visible_ && DevicePose(right, &hand) && DevicePose(vr::k_unTrackedDeviceIndex_Hmd, &head)) {
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

bool Panel::PointerRay(int hand, Mat* ray) {
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
void Panel::UpdatePointing(Surface& surface, Pointing& pointing, bool shown, bool hold, const char* name) {
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
    Log("%s takes the controllers: %s tip points at %.3f, %.3f", name, hitHand ? "right" : "left", hitUv.v[0],
        hitUv.v[1]);
    if (&surface == &panel_) logNextPanelMove_ = true;
  } else {
    Log("%s %s the controllers", name, want ? "takes" : "releases");
  }
}

bool Panel::Tick() {
  vr::VREvent_t ev;
  while (system_->PollNextEvent(&ev, sizeof ev)) {
    if (ev.eventType == vr::VREvent_Quit) {
      system_->AcknowledgeQuit_Exiting();
      return false;
    }
  }
  PollPanelEvents();
  PollButtonEvents();
  {
    std::lock_guard<std::mutex> lock(g_inbox.mutex);
    Upload(panel_, g_inbox.panel, true);
    Upload(button_, g_inbox.button, false);
  }
  UpdateButton();

  if (actionSet_ != vr::k_ulInvalidActionSetHandle) {
    vr::VRActiveActionSet_t active{};
    active.ulActionSet = actionSet_;
    input_->UpdateActionState(&active, sizeof active, 1);
  }
  UpdatePointing(panel_, panelPointing_, visible_, dragging_ || keyboardOpen_, "panel");
  UpdatePointing(button_, buttonPointing_, buttonShown_, false, "button");
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

void DrainCommands(Panel& panel) {
  std::deque<std::pair<uint32_t, std::vector<uint8_t>>> commands;
  {
    std::lock_guard<std::mutex> lock(g_inbox.mutex);
    commands.swap(g_inbox.commands);
  }
  for (auto& c : commands) panel.HandleCommand(c.first, c.second);
}

}  // namespace

int main() {
  std::thread reader(ReadStdin);
  reader.detach();

  Panel panel;
  Emit("{\"t\":\"hello\"}");
  bool reportedDown = false;

  while (!g_inbox.closed) {
    if (!SteamVrRunning()) {
      if (!reportedDown) { Emit("{\"t\":\"steamvr\",\"up\":false}"); reportedDown = true; }
      // Messages still count while SteamVR is away: placement and size are
      // kept for when it comes back.
      for (int i = 0; i < 20 && !g_inbox.closed; ++i) {
        DrainCommands(panel);
        Sleep(100);
      }
      continue;
    }
    if (!panel.Start()) {
      Sleep(2000);
      continue;
    }
    reportedDown = false;

    while (!g_inbox.closed) {
      DrainCommands(panel);
      if (!panel.Tick()) break;
      // Controller input is polled, so the loop also wakes on its own at
      // about the headset's frame rate.
      WaitForSingleObject(g_inboxSignal, 11);
    }
    panel.Stop();
    Emit("{\"t\":\"steamvr\",\"up\":false}");
    reportedDown = true;
  }
  panel.Stop();
  return 0;
}
