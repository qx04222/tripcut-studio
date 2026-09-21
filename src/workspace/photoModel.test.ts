import { describe, expect, it } from "vitest";
import { photoDimensions, photoSizeLabel } from "./photoModel";
import { photoFixture } from "./photoTestFixtures";

describe("photo EXIF display dimensions", () => {
  it.each([5, 6, 7, 8])("swaps metadata axes for orientation %i", (orientation) => {
    const clip = { ...photoFixture, photo: { ...photoFixture.photo!, orientation } };
    expect(photoDimensions(clip)).toEqual({ width: 3024, height: 4032 });
    expect(photoSizeLabel(clip)).toBe("3024×4032");
  });

  it.each([1, 2, 3, 4])("keeps metadata axes for orientation %i", (orientation) => {
    const clip = { ...photoFixture, photo: { ...photoFixture.photo!, orientation } };
    expect(photoDimensions(clip)).toEqual({ width: 4032, height: 3024 });
    expect(photoSizeLabel(clip)).toBe("4032×3024");
  });
});
