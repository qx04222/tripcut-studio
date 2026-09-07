import os, time, torch
from transformers import ChineseCLIPModel, ChineseCLIPProcessor

S3 = os.environ["S3DIR"]
MODEL_NAME = "OFA-Sys/chinese-clip-vit-base-patch16"

class VisionWrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model
    def forward(self, pixel_values):
        return self.model.get_image_features(pixel_values=pixel_values).pooler_output

class TextWrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model
    def forward(self, input_ids, attention_mask):
        return self.model.get_text_features(input_ids=input_ids, attention_mask=attention_mask).pooler_output

def main():
    model = ChineseCLIPModel.from_pretrained(MODEL_NAME)
    processor = ChineseCLIPProcessor.from_pretrained(MODEL_NAME)
    model.eval()

    dummy_pixel = torch.randn(1, 3, 224, 224)
    vision = VisionWrapper(model)
    vision.eval()

    vision_path = os.path.join(S3, "vision.onnx")
    print("exporting vision tower...")
    try:
        torch.onnx.export(
            vision, (dummy_pixel,), vision_path,
            input_names=["pixel_values"], output_names=["image_features"],
            dynamic_axes={"pixel_values": {0: "batch"}, "image_features": {0: "batch"}},
            opset_version=17,
        )
        print("vision export OK ->", vision_path)
    except Exception as e:
        print("VISION EXPORT FAILED:", repr(e))

    # text tower export
    text_path = os.path.join(S3, "text.onnx")
    print("exporting text tower...")
    tin = processor(text=["测试文本"], padding="max_length", max_length=52, return_tensors="pt")
    text = TextWrapper(model)
    text.eval()
    try:
        torch.onnx.export(
            text, (tin["input_ids"], tin["attention_mask"]), text_path,
            input_names=["input_ids", "attention_mask"], output_names=["text_features"],
            dynamic_axes={"input_ids": {0: "batch"}, "attention_mask": {0: "batch"}, "text_features": {0: "batch"}},
            opset_version=17,
        )
        print("text export OK ->", text_path)
    except Exception as e:
        print("TEXT EXPORT FAILED:", repr(e))

if __name__ == "__main__":
    main()
