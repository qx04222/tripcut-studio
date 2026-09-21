import type { ClipListItem } from "../api";

export const videoFixture: ClipListItem = {
  id: 1, episode_id: 1, folder_label: null, cover_url: "/cover.jpg",
  file_name: "video.mov", path: "/mock/video.mov", byte_size: 1024,
  quick_hash: null, full_hash: null, tb_num: 1, tb_den: 1000,
  duration_ticks: 12000, fps_num: 30, fps_den: 1, is_vfr: false,
  codec: "h264", width: 1920, height: 1080, captured_at: "2026-08-12T09:00:00Z",
  status: "ready", error: null, analysis: null, analysis_status: null,
  analysis_error: null, motion: null, motion_status: null, motion_error: null,
  kind: "video",
  binary_rating: null, star_rating: null, select_count: 0,
};
export const photoFixture: ClipListItem = {
  ...videoFixture, id: 2, kind: "photo", file_name: "portrait.jpg", path: "/mock/portrait.jpg",
  duration_ticks: 0, fps_num: null, fps_den: null, captured_at: null,
  // 形状以 photo-core 的 Rust DTO 为准(photo_probe.rs::PhotoMetaDto / companions.rs::CompanionDto)。
  photo: { width: 4032, height: 3024, orientation: 6, taken_at: "2026-08-12T08:00:00Z", taken_at_local: "2026-08-12T16:00:00+08:00", tz_guess: "UTC+08:00", hold_ms: 3000,
    camera: "Sony A7R III", lens: "35mm", gps_lat: 25.7, gps_lon: 100.2,
    color_space: "sRGB", has_alpha: false, companions_ambiguous: false,
    preview_url: "http://127.0.0.1/cache/2/preview.jpg?expires=1&signature=photo" },
  companions: [
    { id: 1, clip_id: 2, path: "/mock/portrait.ARW", role: "raw", size: 4096, mtime: null },
    { id: 2, clip_id: 2, path: "/mock/portrait.xmp", role: "xmp", size: 512, mtime: null },
  ],
};
