import os, time, glob, json, resource
import numpy as np
import onnxruntime as ort
from PIL import Image
from transformers import ChineseCLIPProcessor

S3 = os.environ["S3DIR"]
IMG_DIR = os.path.join(S3, "imgs")
MODEL_NAME = "OFA-Sys/chinese-clip-vit-base-patch16"

def peak_rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024)

def percentile(vals, p):
    s = sorted(vals)
    k = (len(s) - 1) * p
    f = int(k)
    c = min(f + 1, len(s) - 1)
    if f == c:
        return s[f]
    return s[f] + (s[c] - s[f]) * (k - f)

def make_session(onnx_path, provider):
    providers = [provider]
    if provider != "CPUExecutionProvider":
        providers.append("CPUExecutionProvider")
    so = ort.SessionOptions()
    t0 = time.time()
    try:
        sess = ort.InferenceSession(onnx_path, sess_options=so, providers=providers)
        load_time = time.time() - t0
        actual = sess.get_providers()
        return sess, load_time, actual, None
    except Exception as e:
        return None, time.time() - t0, None, str(e)

def bench_provider(sess, provider_name, processor, images, queries, results):
    key = provider_name
    # batch=1 vision
    latencies_b1 = []
    for img in images:
        inp = processor(images=[img], return_tensors="np")
        pv = inp["pixel_values"].astype(np.float32)
        t0 = time.time()
        out = sess.run(None, {"pixel_values": pv})
        latencies_b1.append((time.time() - t0) * 1000)
    results[f"{key}_batch1_p50_ms"] = percentile(latencies_b1, 0.5)
    results[f"{key}_batch1_p95_ms"] = percentile(latencies_b1, 0.95)
    results[f"{key}_batch1_total_s"] = sum(latencies_b1) / 1000
    print(f"[{key} batch=1] p50={results[f'{key}_batch1_p50_ms']:.1f}ms p95={results[f'{key}_batch1_p95_ms']:.1f}ms total={results[f'{key}_batch1_total_s']:.2f}s")

    # batch=8
    latencies_b8 = []
    bs = 8
    for i in range(0, len(images), bs):
        batch = images[i:i+bs]
        inp = processor(images=batch, return_tensors="np")
        pv = inp["pixel_values"].astype(np.float32)
        t0 = time.time()
        out = sess.run(None, {"pixel_values": pv})
        dt = (time.time() - t0) * 1000
        latencies_b8.extend([dt / len(batch)] * len(batch))
    results[f"{key}_batch8_p50_ms_per_frame"] = percentile(latencies_b8, 0.5)
    results[f"{key}_batch8_p95_ms_per_frame"] = percentile(latencies_b8, 0.95)
    results[f"{key}_batch8_total_s"] = sum(latencies_b8) / 1000
    print(f"[{key} batch=8] p50={results[f'{key}_batch8_p50_ms_per_frame']:.1f}ms/frame p95={results[f'{key}_batch8_p95_ms_per_frame']:.1f}ms/frame total={results[f'{key}_batch8_total_s']:.2f}s")
    return latencies_b1

def main():
    processor = ChineseCLIPProcessor.from_pretrained(MODEL_NAME)
    img_paths = sorted(glob.glob(os.path.join(IMG_DIR, "*.jpg")))[:100]
    images = [Image.open(p).convert("RGB") for p in img_paths]
    print(f"[data] {len(images)} images loaded")

    queries = [
        "傍晚海边逆光走路的镜头", "雨中城市夜景霓虹灯", "山间徒步露营的画面",
        "孩子在草地上奔跑玩耍", "高速公路航拍全景", "咖啡馆里安静看书的人",
        "雪山日出金色光线", "海浪拍打礁石慢镜头", "老街小巷烟火气",
        "篝火旁朋友聚会聊天", "森林小径晨雾弥漫", "城市天际线夜景延时",
        "沙滩日落情侣散步", "古镇石板路雨后反光", "田野油菜花盛开",
        "地铁站人来人往", "厨房里做饭的特写", "演唱会舞台灯光",
        "雪地里堆雪人的孩子", "湖面倒影群山",
    ]

    vision_onnx = os.path.join(S3, "vision.onnx")
    text_onnx = os.path.join(S3, "text.onnx")
    results = {}

    for provider in ["CoreMLExecutionProvider", "CPUExecutionProvider"]:
        print(f"\n=== provider: {provider} ===")
        sess, load_time, actual, err = make_session(vision_onnx, provider)
        if sess is None:
            results[f"{provider}_error"] = err
            print(f"[{provider}] FAILED TO CREATE SESSION: {err}")
            continue
        results[f"{provider}_load_time_s"] = load_time
        results[f"{provider}_actual_providers"] = actual
        print(f"[{provider}] session load {load_time:.2f}s actual_providers={actual}")
        # warmup
        try:
            inp = processor(images=images[:2], return_tensors="np")
            pv = inp["pixel_values"].astype(np.float32)
            _ = sess.run(None, {"pixel_values": pv})
            bench_provider(sess, provider, processor, images, queries, results)
        except Exception as e:
            results[f"{provider}_runtime_error"] = str(e)
            print(f"[{provider}] RUNTIME INFERENCE FAILED: {e}")
            continue

    # text tower benchmark - use CPU EP (CoreML often weak for text/seq ops; test both)
    for provider in ["CoreMLExecutionProvider", "CPUExecutionProvider"]:
        tsess, tload, tactual, terr = make_session(text_onnx, provider)
        if tsess is None:
            results[f"text_{provider}_error"] = terr
            print(f"[text {provider}] FAILED: {terr}")
            continue
        results[f"text_{provider}_load_time_s"] = tload
        results[f"text_{provider}_actual_providers"] = tactual
        text_latencies = []
        try:
            for q in queries:
                tin = processor(text=[q], padding="max_length", max_length=52, return_tensors="np")
                ii = tin["input_ids"].astype(np.int64)
                am = tin["attention_mask"].astype(np.int64)
                t0 = time.time()
                out = tsess.run(None, {"input_ids": ii, "attention_mask": am})
                text_latencies.append((time.time() - t0) * 1000)
            results[f"text_{provider}_p50_ms"] = percentile(text_latencies, 0.5)
            results[f"text_{provider}_p95_ms"] = percentile(text_latencies, 0.95)
            print(f"[text {provider}] p50={results[f'text_{provider}_p50_ms']:.1f}ms p95={results[f'text_{provider}_p95_ms']:.1f}ms actual={tactual}")
        except Exception as e:
            results[f"text_{provider}_runtime_error"] = str(e)
            print(f"[text {provider}] RUNTIME INFERENCE FAILED: {e}")
            continue

    # sanity similarity matrix using CPU EP (most reliable) for both towers
    vsess, _, _, verr = make_session(vision_onnx, "CPUExecutionProvider")
    tsess, _, _, terr = make_session(text_onnx, "CPUExecutionProvider")
    if vsess and tsess:
        inp = processor(images=images, return_tensors="np")
        pv = inp["pixel_values"].astype(np.float32)
        img_feats = vsess.run(None, {"pixel_values": pv})[0]
        img_feats = img_feats / np.linalg.norm(img_feats, axis=-1, keepdims=True)

        txt_feats_list = []
        for q in queries:
            tin = processor(text=[q], padding="max_length", max_length=52, return_tensors="np")
            ii = tin["input_ids"].astype(np.int64)
            am = tin["attention_mask"].astype(np.int64)
            tf = tsess.run(None, {"input_ids": ii, "attention_mask": am})[0]
            txt_feats_list.append(tf[0])
        txt_feats = np.stack(txt_feats_list)
        txt_feats = txt_feats / np.linalg.norm(txt_feats, axis=-1, keepdims=True)

        sim = txt_feats @ img_feats.T
        results["sanity_has_nan"] = bool(np.isnan(sim).any())
        results["sanity_sim_min"] = float(sim.min())
        results["sanity_sim_max"] = float(sim.max())
        results["sanity_sim_std"] = float(sim.std())
        results["sanity_row_argmax_unique_count"] = int(len(set(sim.argmax(axis=1).tolist())))
        print(f"[onnx sanity] nan={results['sanity_has_nan']} min={sim.min():.4f} max={sim.max():.4f} std={sim.std():.4f} unique_top1={results['sanity_row_argmax_unique_count']}/{len(queries)}")

    results["peak_rss_mb"] = peak_rss_mb()
    print(f"[mem] peak_rss={results['peak_rss_mb']:.0f}MB")

    with open(os.path.join(S3, "onnx_results.json"), "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

if __name__ == "__main__":
    main()
