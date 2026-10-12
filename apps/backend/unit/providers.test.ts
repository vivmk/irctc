import { afterEach, describe, expect, it } from "vitest";
import { sendEmail, sendSms, setSmsDown } from "../src/providers";

afterEach(() => setSmsDown(false));

describe("fake providers", () => {
  it("email and sms succeed by default", async () => {
    await expect(sendEmail("a@b.co", "hi")).resolves.toBeUndefined();
    await expect(sendSms("9876543210", "hi")).resolves.toBeUndefined();
  });

  it("sms fails while switched down, and email is unaffected", async () => {
    setSmsDown(true);
    await expect(sendSms("9876543210", "hi")).rejects.toThrow("SMS provider unavailable");
    await expect(sendEmail("a@b.co", "hi")).resolves.toBeUndefined();
  });

  it("sms recovers when switched back up", async () => {
    setSmsDown(true);
    setSmsDown(false);
    await expect(sendSms("9876543210", "hi")).resolves.toBeUndefined();
  });
});
