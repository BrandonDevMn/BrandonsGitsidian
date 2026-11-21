import { requestUrl } from "obsidian";
import type { Http } from "../github/client";

/** All GitHub traffic goes through requestUrl (no fetch; handles CORS on iOS). specs/12. */
export const obsidianHttp: Http = async (req) => {
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    throw: false,
  });
  return { status: res.status, headers: res.headers, text: res.text };
};
