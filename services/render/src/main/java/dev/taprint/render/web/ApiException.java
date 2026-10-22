/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render.web;

import org.springframework.http.HttpStatus;

import java.util.List;

/**
 * Explicit API error carrying an HTTP status, a stable machine code, a
 * human-readable message and optional details. Every rejection path in the
 * service goes through this type — nothing fails silently.
 */
public class ApiException extends RuntimeException {

    private final String code;
    private final HttpStatus status;
    private final List<String> details;

    public ApiException(String code, HttpStatus status, String message) {
        this(code, status, message, null);
    }

    public ApiException(String code, HttpStatus status, String message, List<String> details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details == null ? List.of() : List.copyOf(details);
    }

    public static ApiException badRequest(String code, String message) {
        return new ApiException(code, HttpStatus.BAD_REQUEST, message);
    }

    public static ApiException payloadTooLarge(String code, String message) {
        return new ApiException(code, HttpStatus.PAYLOAD_TOO_LARGE, message);
    }

    public static ApiException unprocessable(String code, String message) {
        return new ApiException(code, HttpStatus.UNPROCESSABLE_ENTITY, message);
    }

    public static ApiException unprocessable(String code, String message, List<String> details) {
        return new ApiException(code, HttpStatus.UNPROCESSABLE_ENTITY, message, details);
    }

    public String getCode() {
        return code;
    }

    public HttpStatus getStatus() {
        return status;
    }

    public List<String> getDetails() {
        return details;
    }
}
