import os, time, glob, json, resource
import torch
from PIL import Image
from transformers import ChineseCLIPModel, ChineseCLIPProcessor

S3 = os.environ["S3DIR"]
IMG_DIR = os.path.join(S3, "imgs")
MODEL_NAME = "OFA-Sys/chinese-clip-vit-base-patch16"

def peak_rss_mb():
    # ru_maxrss on macOS is in bytes
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024)

def percentile(vals, p):
    s = sorted(vals)
    k = (len(s) - 1) * p
    f = int(k)
    c = min(f + 1, len(s) - 1)
    if f == c:
        return s[f]
    return s[f] + (s[c] - s[f]) * (k - f)

def main():
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    results = {"device": device}

    t0 = time.time()
    model = ChineseCLIPModel.from_pretrained(MODEL_NAME)
    processor = ChineseCLIPProcessor.from_pretrained(MODEL_NAME)
    model.to(device)
    model.eval()
    load_time = time.time() - t0
    results["load_time_s"] = load_time
    print(f"[load] {load_time:.2f}s device={device}")

    img_paths = sorted(glob.glob(os.path.join(IMG_DIR, "*.jpg")))[:100]
    images = [Image.open(p).convert("RGB") for p in img_paths]
    print(f"[data] {len(images)} images loaded")

    # warmup
    with torch.no_grad():
        inp = processor(images=images[:4], return_tensors="pt").to(device)
        _ = model.get_image_features(**inp)
        if device == "mps":
            torch.mps.synchronize()

    # batch=1
    latencies_b1 = []
    with torch.no_grad():
        for img in images:
            t0 = time.time()
            inp = processor(images=[img], return_tensors="pt").to(device)
            feat = model.get_image_features(**inp)
            if device == "mps":
                torch.mps.synchronize()
            latencies_b1.append((time.time() - t0) * 1000)
    results["batch1_p50_ms"] = percentile(latencies_b1, 0.5)
    results["batch1_p95_ms"] = percentile(latencies_b1, 0.95)
    results["batch1_mean_ms"] = sum(latencies_b1) / len(latencies_b1)
    results["batch1_total_s"] = sum(latencies_b1) / 1000
    print(f"[batch=1] p50={results['batch1_p50_ms']:.1f}ms p95={results['batch1_p95_ms']:.1f}ms total={results['batch1_total_s']:.2f}s")

    # batch=8
    latencies_b8 = []
    bs = 8
    with torch.no_grad():
        for i in range(0, len(images), bs):
            batch = images[i:i+bs]
            t0 = time.time()
            inp = processor(images=batch, return_tensors="pt").to(device)
            feat = model.get_image_features(**inp)
            if device == "mps":
                torch.mps.synchronize()
            dt = (time.time() - t0) * 1000
            # per-frame latency within batch
            latencies_b8.extend([dt / len(batch)] * len(batch))
    results["batch8_p50_ms_per_frame"] = percentile(latencies_b8, 0.5)
    results["batch8_p95_ms_per_frame"] = percentile(latencies_b8, 0.95)
    results["batch8_mean_ms_per_frame"] = sum(latencies_b8) / len(latencies_b8)
    results["batch8_total_s"] = sum(latencies_b8) / 1000
    print(f"[batch=8] p50={results['batch8_p50_ms_per_frame']:.1f}ms/frame p95={results['batch8_p95_ms_per_frame']:.1f}ms/frame total={results['batch8_total_s']:.2f}s")

    # text encoding benchmark
    queries = [
        "傍晚海边逆光走路的镜头", "雨中城市夜景霓虹灯", "山间徒步露营的画面",
        "孩子在草地上奔跑玩耍", "高速公路航拍全景", "咖啡馆里安静看书的人",
        "雪山日出金色光线", "海浪拍打礁石慢镜头", "老街小巷烟火气",
        "篝火旁朋友聚会聊天", "森林小径晨雾弥漫", "城市天际线夜景延时",
        "沙滩日落情侣散步", "古镇石板路雨后反光", "田野油菜花盛开",
        "地铁站人来人往", "厨房里做饭的特写", "演唱会舞台灯光",
        "雪地里堆雪人的孩子", "湖面倒影群山",
    ]
    text_latencies = []
    with torch.no_grad():
        for q in queries:
            t0 = time.time()
            tin = processor(text=[q], padding=True, return_tensors="pt").to(device)
            tfeat = model.get_text_features(**tin)
            if device == "mps":
                torch.mps.synchronize()
            text_latencies.append((time.time() - t0) * 1000)
    results["text_p50_ms"] = percentile(text_latencies, 0.5)
    results["text_p95_ms"] = percentile(text_latencies, 0.95)
    results["text_mean_ms"] = sum(text_latencies) / len(text_latencies)
    print(f"[text] p50={results['text_p50_ms']:.1f}ms p95={results['text_p95_ms']:.1f}ms n={len(queries)}")

    # sanity: similarity matrix
    with torch.no_grad():
        img_inp = processor(images=images, return_tensors="pt").to(device)
        img_feats = model.get_image_features(**img_inp).pooler_output
        img_feats = img_feats / img_feats.norm(p=2, dim=-1, keepdim=True)
        txt_inp = processor(text=queries, padding=True, return_tensors="pt").to(device)
        txt_feats = model.get_text_features(**txt_inp).pooler_output
        txt_feats = txt_feats / txt_feats.norm(p=2, dim=-1, keepdim=True)
        sim = (txt_feats @ img_feats.T).cpu().numpy()

    import numpy as np
    has_nan = bool(np.isnan(sim).any())
    results["sanity_has_nan"] = has_nan
    results["sanity_sim_min"] = float(sim.min())
    results["sanity_sim_max"] = float(sim.max())
    results["sanity_sim_std"] = float(sim.std())
    results["sanity_row_argmax_unique_count"] = int(len(set(sim.argmax(axis=1).tolist())))
    print(f"[sanity] nan={has_nan} min={sim.min():.4f} max={sim.max():.4f} std={sim.std():.4f} unique_top1={results['sanity_row_argmax_unique_count']}/{len(queries)}")

    results["peak_rss_mb"] = peak_rss_mb()
    print(f"[mem] peak_rss={results['peak_rss_mb']:.0f}MB")

    with open(os.path.join(S3, "pytorch_results.json"), "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

if __name__ == "__main__":
    main()
