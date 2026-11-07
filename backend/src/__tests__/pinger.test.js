const axios = require("axios");
const { pingUrl } = require("../pinger");

jest.mock("axios");

describe("pingUrl", () => {
  beforeEach(() => jest.clearAllMocks());

  test("caps response and request bodies for every monitor check", async () => {
    axios.request.mockResolvedValue({
      status: 200,
      data: { ok: true },
    });

    const result = await pingUrl("https://example.com");

    expect(result.status).toBe("up");
    const options = axios.request.mock.calls[0][0];
    expect(options.maxContentLength).toBe(1024 * 1024);
    expect(options.maxBodyLength).toBe(1024 * 1024);
    expect(options.maxRedirects).toBe(0);
  });

  test("classifies an oversized response as response_too_large", async () => {
    const error = new Error("maxContentLength size of 1048576 exceeded");
    error.code = "ERR_BAD_RESPONSE";
    axios.request.mockRejectedValue(error);

    const result = await pingUrl("https://example.com");

    expect(result.status).toBe("down");
    expect(result.failureReason).toBe("response_too_large");
    expect(result.httpStatus).toBeNull();
  });

  test("keeps keyword response inspection enabled within the same cap", async () => {
    axios.request.mockResolvedValue({
      status: 200,
      data: "service healthy",
    });

    const result = await pingUrl("https://example.com", {
      keyword: "healthy",
      keywordMode: "present",
    });

    expect(result.status).toBe("up");
    expect(axios.request.mock.calls[0][0].responseType).toBe("text");
    expect(axios.request.mock.calls[0][0].maxContentLength).toBe(1024 * 1024);
  });
});
