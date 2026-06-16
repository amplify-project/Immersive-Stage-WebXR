#include <ins_realtime_stitcher.h>
#include <camera/camera.h>
#include <camera/device_discovery.h>

#include <atomic>
#include <cerrno>
#include <csignal>
#include <cstring>
#include <condition_variable>
#include <fcntl.h>
#include <iostream>
#include <linux/videodev2.h>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <sys/ioctl.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {

std::atomic<bool> g_running{true};

void HandleSignal(int) {
    g_running = false;
}

std::string FourccToString(uint32_t fourcc) {
    char s[] = {
        static_cast<char>(fourcc & 0xff),
        static_cast<char>((fourcc >> 8) & 0xff),
        static_cast<char>((fourcc >> 16) & 0xff),
        static_cast<char>((fourcc >> 24) & 0xff),
        0,
    };
    return std::string(s);
}

void Xioctl(int fd, unsigned long request, void* arg, const std::string& what) {
    while (ioctl(fd, request, arg) == -1) {
        if (errno == EINTR) {
            continue;
        }
        throw std::runtime_error(what + ": " + std::strerror(errno));
    }
}

struct Options {
    std::string device = "/dev/video10";
    int output_width = 2880;  // salida 2880x1440 (leve downscale del stream 3072x1536)
    int output_height = 1440;
    int fps = 24;             // 24 FPS para aliviar CPU
    int bitrate = 45 * 1024 * 1024;
    bool flowstate = true;    // OBLIGATORIO: el SDK crashea con flowstate=false (DynamicStitcher
                              // deja flow_estimator_ nullptr y lo desreferencia al estitchar)
    // Stream de entrada: limita la calidad real. 3072x1536 para alimentar la salida 2880x1440.
    ins_camera::VideoResolution stream_resolution = ins_camera::VideoResolution::RES_3072_1536P30;
    ins::STITCH_TYPE stitch_type = ins::STITCH_TYPE::TEMPLATE; // Template por estabilidad y velocidad
};

class V4L2Output {
public:
    V4L2Output(const std::string& device, int width, int height, int fps)
        : device_(device), width_(width), height_(height), fps_(fps) {
        fd_ = open(device_.c_str(), O_WRONLY);
        if (fd_ < 0) {
            throw std::runtime_error("open " + device_ + ": " + std::strerror(errno));
        }

        v4l2_capability cap{};
        Xioctl(fd_, VIDIOC_QUERYCAP, &cap, "VIDIOC_QUERYCAP");
        const auto caps = (cap.capabilities & V4L2_CAP_DEVICE_CAPS) ? cap.device_caps : cap.capabilities;
        if ((caps & V4L2_CAP_VIDEO_OUTPUT) == 0) {
            throw std::runtime_error(device_ + " is not a V4L2 video output device");
        }

        v4l2_format format{};
        format.type = V4L2_BUF_TYPE_VIDEO_OUTPUT;
        format.fmt.pix.width = width_;
        format.fmt.pix.height = height_;
        // RGB24: el stitcher entrega RGBA; soltamos el alpha (sin OpenCV ni swap R↔B).
        // ffmpeg lee 'rgb24' nativo desde v4l2 (no soporta el RGBA de 4 bytes 'AB24').
        format.fmt.pix.pixelformat = V4L2_PIX_FMT_RGB24;
        format.fmt.pix.field = V4L2_FIELD_NONE;
        format.fmt.pix.bytesperline = width_ * 3;
        format.fmt.pix.sizeimage = width_ * height_ * 3;
        Xioctl(fd_, VIDIOC_S_FMT, &format, "VIDIOC_S_FMT");

        v4l2_streamparm parm{};
        parm.type = V4L2_BUF_TYPE_VIDEO_OUTPUT;
        parm.parm.output.timeperframe.numerator = 1;
        parm.parm.output.timeperframe.denominator = fps_;
        ioctl(fd_, VIDIOC_S_PARM, &parm);

        std::cout << "V4L2 listo: " << device_ << " " << width_ << "x" << height_ << " @ " << fps_ << " fps\n";
    }

    ~V4L2Output() {
        if (fd_ >= 0) {
            close(fd_);
        }
    }

    void WriteFrame(const std::vector<uint8_t>& frame) {
        const uint8_t* ptr = frame.data();
        size_t remaining = frame.size();
        while (remaining > 0 && g_running) {
            const ssize_t written = write(fd_, ptr, remaining);
            if (written < 0) {
                if (errno == EINTR) {
                    continue;
                }
                throw std::runtime_error("write " + device_ + ": " + std::strerror(errno));
            }
            ptr += written;
            remaining -= static_cast<size_t>(written);
        }
    }

private:
    std::string device_;
    int width_, height_, fps_, fd_ = -1;
};

// COLA OPTIMIZADA: Evita la acumulación de retraso vaciando buffers atrasados
class LatestFrameQueue {
public:
    void Push(std::vector<uint8_t>&& frame) {
        std::lock_guard<std::mutex> lock(mutex_);
        // Si ya hay un frame esperando y llega uno nuevo, descartamos el antiguo 
        // para que el retraso acumulado no congele el SDK de la cámara
        if (has_frame_) {
            latest_.clear();
        }
        latest_ = std::move(frame);
        has_frame_ = true;
        cond_.notify_one();
    }

    bool WaitPop(std::vector<uint8_t>& frame) {
        std::unique_lock<std::mutex> lock(mutex_);
        cond_.wait(lock, [&]() { return !g_running || has_frame_; });
        if (!has_frame_ || !g_running) {
            return false;
        }
        frame.swap(latest_);
        has_frame_ = false;
        return true;
    }

    void Wake() {
        cond_.notify_all();
    }

private:
    std::mutex mutex_;
    std::condition_variable cond_;
    std::vector<uint8_t> latest_;
    bool has_frame_ = false;
};

class WriterThreadGuard {
public:
    WriterThreadGuard(std::thread& writer, LatestFrameQueue& queue)
        : writer_(writer), queue_(queue) {}

    ~WriterThreadGuard() {
        g_running = false;
        queue_.Wake();
        if (writer_.joinable()) {
            writer_.join();
        }
    }

private:
    std::thread& writer_;
    LatestFrameQueue& queue_;
};

class StitchDelegate : public ins_camera::StreamDelegate {
public:
    StitchDelegate(const std::shared_ptr<ins::RealTimeStitcher>& stitcher, bool use_gyro)
        : stitcher_(stitcher), use_gyro_(use_gyro) {}

    void OnAudioData(const uint8_t*, size_t, int64_t) override {}

    void OnVideoData(const uint8_t* data, size_t size, int64_t timestamp, uint8_t stream_type, int stream_index) override {
        stitcher_->HandleVideoData(data, size, timestamp, stream_type, stream_index);
    }

    void OnGyroData(const std::vector<ins_camera::GyroData>& data) override {
        // El giroscopio solo lo consume FlowState/DirectionLock. Con FlowState off
        // (cámara estática) el flow_estimator_ es nullptr; inyectar gyro lo
        // desreferencia → segfault. Por eso no lo reenviamos si no hay flowstate.
        if (!use_gyro_) return;
        std::vector<ins::GyroData> gyro(data.size());
        std::memcpy(gyro.data(), data.data(), data.size() * sizeof(ins_camera::GyroData));
        stitcher_->HandleGyroData(gyro);
    }

    void OnExposureData(const ins_camera::ExposureData& data) {
        ins::ExposureData exposure{};
        exposure.exposure_time = data.exposure_time;
        exposure.timestamp = data.timestamp;
        stitcher_->HandleExposureData(exposure);
    }

private:
    std::shared_ptr<ins::RealTimeStitcher> stitcher_;
    bool use_gyro_ = true;
};

}  // namespace

int main() {
    std::signal(SIGINT, HandleSignal);
    std::signal(SIGTERM, HandleSignal);

    try {
        Options options;

        ins::InitEnv();
        ins_camera::SetLogLevel(ins_camera::LogLevel::WARNING);
        ins::SetLogLevel(ins::InsLogLevel::WARNING);

        V4L2Output v4l2(options.device, options.output_width, options.output_height, options.fps);
        LatestFrameQueue queue;

        std::cout << "Buscando dispositivo Insta360...\n";
        ins_camera::DeviceDiscovery discovery;
        // Reintento con espera: al rearrancar, el USB puede no haber re-enumerado
        // todavía (el SDK acaba de soltarlo). Sin esto, un solo intento falla.
        std::vector<ins_camera::DeviceDescriptor> devices;
        for (int attempt = 1; attempt <= 15 && g_running; ++attempt) {
            devices = discovery.GetAvailableDevices();
            if (!devices.empty()) break;
            discovery.FreeDeviceDescriptors(devices);
            devices.clear();
            std::cout << "  cámara no encontrada (intento " << attempt << "/15), reintentando en 1s...\n";
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
        if (devices.empty()) {
            throw std::runtime_error("no se encontró ninguna cámara Insta360 tras 15 intentos (¿conectada y en modo USB?).");
        }

        auto cam = std::make_shared<ins_camera::Camera>(devices[0].info);
        if (!cam->Open()) {
            discovery.FreeDeviceDescriptors(devices);
            throw std::runtime_error("error abriendo la sesión de la cámara.");
        }
        discovery.FreeDeviceDescriptors(devices);

        auto stitcher = std::make_shared<ins::RealTimeStitcher>();
        ins::CameraInfo camera_info;
        const auto preview_param = cam->GetPreviewParam();
        camera_info.cameraName = preview_param.camera_name;
        camera_info.decode_type = static_cast<ins::VideoDecodeType>(preview_param.encode_type);
        camera_info.offset = preview_param.offset;
        camera_info.window_crop_info_.crop_offset_x = preview_param.crop_info.crop_offset_x;
        camera_info.window_crop_info_.crop_offset_y = preview_param.crop_info.crop_offset_y;
        camera_info.window_crop_info_.dst_width = preview_param.crop_info.dst_width;
        camera_info.window_crop_info_.dst_height = preview_param.crop_info.dst_height;
        camera_info.window_crop_info_.src_width = preview_param.crop_info.src_width;
        camera_info.window_crop_info_.src_height = preview_param.crop_info.src_height;

        stitcher->SetCameraInfo(camera_info);
        stitcher->SetStitchType(options.stitch_type);
        stitcher->EnableFlowState(options.flowstate);
        stitcher->SetOutputSize(options.output_width, options.output_height);
        
        stitcher->SetStitchRealTimeDataCallback(
            [&](uint8_t* data[4], int linesize[4], int width, int height, int, int64_t) {
                if (!g_running || data[0] == nullptr) return;
                if (width != options.output_width || height != options.output_height) return;

                // RGBA → RGB24: copia 3 de cada 4 bytes (suelta el alpha), sin swap ni
                // conversión de color. Respeta linesize[0] por si hay padding de fila.
                std::vector<uint8_t> frame(static_cast<size_t>(width) * height * 3);
                uint8_t* dst = frame.data();
                for (int y = 0; y < height; ++y) {
                    const uint8_t* src = data[0] + static_cast<size_t>(y) * linesize[0];
                    for (int x = 0; x < width; ++x, src += 4, dst += 3) {
                        dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2];
                    }
                }
                queue.Push(std::move(frame));
            });

        // Casteo explícito a la clase base requerida para evitar errores de referencia del compilador
        std::shared_ptr<ins_camera::StreamDelegate> delegate = std::make_shared<StitchDelegate>(stitcher, options.flowstate);
        cam->SetStreamDelegate(delegate);

        ins_camera::LiveStreamParam param;
        param.video_resolution = options.stream_resolution;
        param.lrv_video_resulution = options.stream_resolution;
        param.video_bitrate = options.bitrate;
        param.enable_audio = false;
        param.using_lrv = false;

        stitcher->StartStitch();

        if (!cam->StartLiveStreaming(param)) {
            stitcher->CancelStitch();
            cam->Close();
            throw std::runtime_error("error iniciando el live stream desde el SDK.");
        }

        std::thread writer([&]() {
            std::vector<uint8_t> frame;
            while (g_running) {
                if (queue.WaitPop(frame)) {
                    v4l2.WriteFrame(frame);
                }
            }
        });
        WriterThreadGuard writer_guard(writer, queue);

        std::cout << "\n======================================================\n";
        std::cout << " Transmitiendo puente 4K a 24 FPS en: " << options.device << "\n";
        std::cout << " Control de retraso activado. Presiona Ctrl+C para salir.\n";
        std::cout << "======================================================\n\n";

        while (g_running) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        std::cout << "Cerrando captura y liberando descriptores...\n";
        cam->StopLiveStreaming();
        stitcher->CancelStitch();
        cam->Close();
        return 0;
    } catch (const std::exception& e) {
        g_running = false;
        std::cerr << "error: " << e.what() << "\n";
        return 1;
    }
}
