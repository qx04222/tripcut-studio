import type { ClipListItem } from "../api";

/** Synthetic, offline images with baked orientation; never reads the owner's photo library. */
function preview(portrait: boolean, index: number): string {
  const w = portrait ? 768 : 1024;
  const h = portrait ? 1024 : 768;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#7296a8"/><stop offset="1" stop-color="#e7d8b4"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#sky)"/>
    <circle cx="${w * .72}" cy="${h * .25}" r="55" fill="#f8e4aa"/>
    <path d="M0 ${h * .6} L${w * .22} ${h * .3} L${w * .52} ${h * .7} L${w * .76} ${h * .42} L${w} ${h * .65} V${h} H0Z" fill="#576c67"/>
    <path d="M0 ${h * .7} Q${w * .5} ${h * .57} ${w} ${h * .77} V${h} H0Z" fill="#94a69d"/>
    <path d="M0 ${h * .87} Q${w * .3} ${h * .65} ${w} ${h} H0Z" fill="#384b40"/>
    <text x="32" y="${h - 32}" font-family="sans-serif" font-size="24" fill="#f4ecda">PHOTO ${index + 1} · OFFLINE FIXTURE</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function buildPhotoFixtures(base: ClipListItem): ClipListItem[] {
  return Array.from({ length: 6 }, (_, index) => {
    const id = 201 + index;
    const name = ["湖畔晨光.JPG", "竖拍山景.HEIC", "湖边散步.JPG", "营地日落.PNG", "山路云海.JPG", "夜色小镇.HEIC"][index]!;
    const url = preview(index === 1, index);
    return {
      ...base, id, kind: "photo", file_name: name, path: `/mock/photos/${name}`,
      cover_url: url, duration_ticks: 0, fps_num: null, fps_den: null,
      // clips.width/height 已按方向换算(photo-core:竖图 3024×4032),photo.width/height 是原始像素 + orientation。
      width: index === 1 ? 3024 : 4032, height: index === 1 ? 4032 : 3024, codec: null, is_vfr: false, byte_size: 4500000,
      quick_hash: null, full_hash: null, captured_at: null,
      // R21 PH-07:index 4(山路云海.JPG)带一条真实形状的失焦分析结果，
      // 让 MediaPool 的「疑似废片」chip 在假后端下也有数据可渲染
      // （之前 analysis 恒为 null，chip 的 suspectedPhoto() 条件永远不成立）。
      analysis: index === 4 ? {
        clip_id: id, exposure_yavg: 90, overexposed_ratio: 0, audio_peak_db: null, audio_clipped: false,
        has_audio: false, focus_scores: [18], scene_count: 1, analyzed_at: "2026-08-12T08:19:00+08:00",
        tool_versions: { photo_l1: "photo-v1", suspect_junk: true }, underexposed_ratio: 0,
        dynamic_range: 40, blur_mean: 0, entropy_mean: 5.2, motion_mean: 0, out_of_focus_ratio: 0.4,
      } : null,
      analysis_status: index === 4 ? "done" : null, analysis_error: null, motion: null, motion_status: null, motion_error: null,
      binary_rating: index === 0 ? 1 : null, star_rating: null, select_count: 0,
      rotation: 0, orientation: index === 1 ? "portrait" : "landscape",
      generated_source: null, missing_since: null, device_model: null,
      has_suggestions: false, photo: {
        width: 4032, height: 3024, orientation: index === 1 ? 6 : 1,
        taken_at: `2026-08-12T00:${String(index * 8 + 3).padStart(2, "0")}:00Z`,
        taken_at_local: `2026-08-12T08:${String(index * 8 + 3).padStart(2, "0")}:00+08:00`, tz_guess: "UTC+08:00", hold_ms: 3000,
        camera: index === 0 ? "Sony A7R III" : null, lens: index === 0 ? "FE 35mm F1.8" : null,
        gps_lat: index === 0 ? 25.7 : null, gps_lon: index === 0 ? 100.2 : null,
        color_space: "sRGB", has_alpha: name.endsWith(".PNG"), companions_ambiguous: false,
        preview_url: url,
      }, companions: index === 0 ? [
        { id: 9001, clip_id: id, path: "/mock/photos/湖畔晨光.ARW", role: "raw", size: 42_000_000, mtime: null },
        { id: 9002, clip_id: id, path: "/mock/photos/湖畔晨光.xmp", role: "xmp", size: 5_120, mtime: null },
      ] : [],
    };
  });
}

/**
 * R21 PH-10(接线 W3):一张无伴随 JPG 的独立 ARW,让 preview-shots 能截到「RAW」角标与
 * 「RAW 预览较小」提示。不进相似组(×6 折叠计数不变),只在 ?photos=1 下追加到媒体池。
 */
export function buildStandaloneRawFixture(base: ClipListItem): ClipListItem {
  const url = preview(false, 6);
  const name = "独立星野.ARW";
  return {
    ...base, id: 207, kind: "photo", file_name: name, path: `/mock/photos/${name}`,
    cover_url: url, duration_ticks: 0, fps_num: null, fps_den: null,
    width: 7952, height: 5304, codec: null, is_vfr: false, byte_size: 84_000_000,
    quick_hash: null, full_hash: null, captured_at: null,
    analysis: null, analysis_status: null, analysis_error: null, motion: null, motion_status: null, motion_error: null,
    binary_rating: null, star_rating: null, select_count: 0,
    rotation: 0, orientation: "landscape",
    generated_source: null, missing_since: null, device_model: null,
    has_suggestions: false, photo: {
      width: 7952, height: 5304, orientation: 1,
      taken_at: "2026-08-12T15:40:00Z", taken_at_local: "2026-08-12T23:40:00+08:00", tz_guess: "UTC+08:00", hold_ms: 3000,
      camera: "Sony A7R III", lens: "FE 24mm F1.4", gps_lat: null, gps_lon: null,
      color_space: "sRGB", has_alpha: false, companions_ambiguous: false,
      preview_url: url,
      raw_container: "arw", preview_source: "embedded",
      preview_width: 1616, preview_height: 1080, embedded_preview_width: 1616, embedded_preview_height: 1080,
      preview_small: true,
    }, companions: [],
  };
}
