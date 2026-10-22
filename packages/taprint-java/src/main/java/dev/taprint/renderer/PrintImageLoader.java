/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.core.PrintErrorCode;
import dev.taprint.core.PrintKernelException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Image loader: data URIs (base64) and http(s) URLs with a small LRU cache
 * so a template referencing the same image twice loads it once.
 *
 * <p>HTTP fetching uses the JDK built-in {@link HttpClient}; responses above
 * 5MB are skipped. Thread interruption is honored: a cancelled render fails
 * fast with {@link PrintErrorCode#RENDER_TIMEOUT}.</p>
 */
public class PrintImageLoader {

    private static final Logger log = LoggerFactory.getLogger(PrintImageLoader.class);
    private static final int MAX_CACHE = 64;
    private static final long MAX_BYTES = 5L * 1024 * 1024;

    private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final Map<String, byte[]> cache = new LinkedHashMap<String, byte[]>(32, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, byte[]> eldest) {
            return size() > MAX_CACHE;
        }
    };

    public synchronized byte[] load(String src) {
        throwIfInterrupted();
        if (src == null || src.trim().isEmpty()) {
            return null;
        }
        byte[] cached = cache.get(src);
        if (cached != null) {
            return cached;
        }
        byte[] bytes;
        if (src.startsWith("data:")) {
            bytes = parseDataUri(src);
        } else if (src.startsWith("http://") || src.startsWith("https://")) {
            bytes = fetchHttp(src);
        } else {
            throw PrintKernelException.of(PrintErrorCode.RENDER_FAILED,
                    "Unsupported image src: " + src);
        }
        if (bytes != null) {
            cache.put(src, bytes);
        }
        throwIfInterrupted();
        return bytes;
    }

    private byte[] parseDataUri(String src) {
        throwIfInterrupted();
        int comma = src.indexOf(',');
        if (comma < 0) {
            throw PrintKernelException.of(PrintErrorCode.RENDER_FAILED, "Malformed data URI");
        }
        String meta = src.substring(5, comma);
        String data = src.substring(comma + 1);
        if (meta.contains("base64")) {
            return Base64.getDecoder().decode(data);
        }
        try {
            return URLDecoder.decode(data, java.nio.charset.StandardCharsets.UTF_8)
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw PrintKernelException.of(PrintErrorCode.RENDER_FAILED,
                    "Data URI decoding failed", e);
        }
    }

    private byte[] fetchHttp(String url) {
        boolean interruptObserved = false;
        try {
            throwIfInterrupted();
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(10))
                    .GET()
                    .build();
            HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (Thread.currentThread().isInterrupted()) {
                interruptObserved = true;
            }
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                log.warn("Image download failed: {} -> {}", url, response.statusCode());
                return null;
            }
            byte[] body = response.body();
            if (body == null || body.length == 0) {
                return null;
            }
            if (body.length > MAX_BYTES) {
                log.warn("Image exceeds the 5MB limit, skipped: {}", url);
                return null;
            }
            if (Thread.currentThread().isInterrupted()) {
                interruptObserved = true;
            }
            return body;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw interruptedWhileLoading(e);
        } catch (IOException e) {
            if (interruptObserved || Thread.currentThread().isInterrupted()) {
                throw interruptedWhileLoading(e);
            }
            log.warn("Image download failed: {} -> {}", url, e.getMessage());
            return null;
        } catch (RuntimeException e) {
            if (Thread.currentThread().isInterrupted()) {
                throw interruptedWhileLoading(e);
            }
            throw e;
        }
    }

    private PrintKernelException interruptedWhileLoading(Exception cause) {
        return PrintKernelException.of(PrintErrorCode.RENDER_TIMEOUT,
                "Render thread interrupted (image loading cancelled)", cause);
    }

    private void throwIfInterrupted() {
        if (Thread.currentThread().isInterrupted()) {
            throw interruptedWhileLoading(new InterruptedException("Image loading cancelled"));
        }
    }
}
