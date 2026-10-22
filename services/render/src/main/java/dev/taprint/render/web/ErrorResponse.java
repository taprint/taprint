/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render.web;

import java.util.List;

/**
 * Uniform error envelope: {@code {"error":{"code","message","details"?}}}.
 * Documented in schema/render-api.json.
 */
public final class ErrorResponse {

    public final ErrorBody error;

    public ErrorResponse(String code, String message, List<String> details) {
        this.error = new ErrorBody(code, message, details);
    }

    public static ErrorResponse of(String code, String message) {
        return new ErrorResponse(code, message, null);
    }

    public static ErrorResponse of(String code, String message, List<String> details) {
        return new ErrorResponse(code, message, details);
    }

    public static final class ErrorBody {
        public final String code;
        public final String message;
        public final List<String> details;

        public ErrorBody(String code, String message, List<String> details) {
            this.code = code;
            this.message = message;
            this.details = details;
        }
    }
}
