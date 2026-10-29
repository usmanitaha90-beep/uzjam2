#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define UZJAM_APO_ABI_VERSION 1u
#define UZJAM_APO_MAX_FILTERS 64u

#define UZJAM_APO_OK 0
#define UZJAM_APO_ERROR_NULL 1
#define UZJAM_APO_ERROR_ABI 2
#define UZJAM_APO_ERROR_VALUE 3
#define UZJAM_APO_ERROR_FILTER_COUNT 4
#define UZJAM_APO_ERROR_DSP 5
#define UZJAM_APO_ERROR_BUSY 6
#define UZJAM_APO_ERROR_PANIC 7
#define UZJAM_APO_ERROR_CHANNELS 8

typedef struct UzjamApoFilterConfig {
    uint32_t enabled;
    uint32_t kind;
    uint32_t channel;
    uint32_t reserved;
    double frequency_hz;
    double gain_db;
    double q;
} UzjamApoFilterConfig;

typedef struct UzjamApoProfileConfig {
    uint32_t size;
    uint32_t abi_version;
    uint32_t filter_count;
    uint32_t enabled;
    double preamp_db;
    double manual_headroom_db;
    double safety_margin_db;
    uint32_t headroom_mode;
    uint32_t clipping_policy;
    uint32_t limiter_enabled;
    uint32_t reserved;
    UzjamApoFilterConfig filters[UZJAM_APO_MAX_FILTERS];
} UzjamApoProfileConfig;

typedef struct UzjamApoHandle UzjamApoHandle;

uint32_t uzjam_apo_abi_version(void);
uint32_t uzjam_apo_profile_config_size(void);
int32_t uzjam_apo_create(double sample_rate_hz, uint32_t channels,
                         const UzjamApoProfileConfig *config,
                         UzjamApoHandle **out_handle);
int32_t uzjam_apo_stage_profile(UzjamApoHandle *handle,
                                const UzjamApoProfileConfig *config);
int32_t uzjam_apo_process_f32(UzjamApoHandle *handle, const float *input,
                              float *output, uint32_t frame_count,
                              uint32_t channels);
uint32_t uzjam_apo_latency_frames(const UzjamApoHandle *handle);
void uzjam_apo_destroy(UzjamApoHandle *handle);

#ifdef __cplusplus
}

static_assert(sizeof(UzjamApoFilterConfig) == 40,
              "Rust/C filter ABI layout changed");
static_assert(sizeof(UzjamApoProfileConfig) == 2616,
              "Rust/C profile ABI layout changed");
#endif
