/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "audio_playback_service.h"

#include <system/runtime_bridge/embedded_runtime_bridge.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <algorithm>
#include <cstdint>
#include <memory>

namespace stackchan::hal::local_companion {
namespace {

constexpr uint32_t kPlaybackTailMs = 250;
constexpr uint32_t kPlaybackTaskStackBytes = 8192;
constexpr char kTag[] = "LocalAudioPlayback";

struct PlaybackTaskArg {
    std::string requestId;
    int volume = -1;
    std::string audio;
    AudioPlaybackFinishedCallback onFinished;
};

void playback_task(void* param)
{
    std::unique_ptr<PlaybackTaskArg> arg(static_cast<PlaybackTaskArg*>(param));
    const bool use_temp_volume = arg->volume >= 0;
    const uint8_t previous_volume = use_temp_volume ? embedded_runtime_bridge::board_get_speaker_volume() : 0;
    if (use_temp_volume) {
        embedded_runtime_bridge::board_set_speaker_volume(
            static_cast<uint8_t>(std::max(0, std::min(100, arg->volume))),
            false
        );
    }
    embedded_runtime_bridge::app_play_sound_and_wait(std::string_view(arg->audio.data(), arg->audio.size()));
    vTaskDelay(pdMS_TO_TICKS(kPlaybackTailMs));
    if (use_temp_volume) {
        embedded_runtime_bridge::board_set_speaker_volume(previous_volume, false);
    }
    if (arg->onFinished) {
        arg->onFinished(arg->requestId);
    }
    arg.reset();
    vTaskDelete(nullptr);
}

}  // namespace

bool start_audio_playback_task(std::string requestId, std::string audio, int volume,
                               AudioPlaybackFinishedCallback onFinished)
{
    auto arg = std::make_unique<PlaybackTaskArg>();
    arg->requestId = std::move(requestId);
    arg->volume = volume;
    arg->audio = std::move(audio);
    arg->onFinished = std::move(onFinished);

    if (xTaskCreate(&playback_task, "local_audio_playback", kPlaybackTaskStackBytes,
                    arg.get(), 4, nullptr) != pdPASS) {
        ESP_LOGE(kTag, "Playback task allocation failed: internal largest=%u, PSRAM largest=%u",
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)));
        return false;
    }
    arg.release();
    return true;
}

}  // namespace stackchan::hal::local_companion
