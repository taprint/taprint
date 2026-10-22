/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render.web;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.List;

/**
 * Maps every failure to the documented error envelope with an explicit
 * status; internal failures never leak stack traces or kernel internals.
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ErrorResponse> apiError(ApiException e) {
        return ResponseEntity.status(e.getStatus())
                .body(ErrorResponse.of(e.getCode(), e.getMessage(),
                        e.getDetails() == null || e.getDetails().isEmpty() ? null : e.getDetails()));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class,
            MissingServletRequestParameterException.class,
            MethodArgumentTypeMismatchException.class})
    public ResponseEntity<ErrorResponse> badSyntax(Exception e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(ErrorResponse.of("bad-request", "Malformed request: " + rootMessage(e)));
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<ErrorResponse> notFound(NoResourceFoundException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(ErrorResponse.of("not-found", "Unknown path " + e.getResourcePath()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> internal(Exception e) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(ErrorResponse.of("internal-error",
                        "Unexpected internal error; see server logs", List.of()));
    }

    private static String rootMessage(Throwable t) {
        String m = t.getMessage();
        return m == null ? t.getClass().getSimpleName()
                : m.substring(0, Math.min(300, m.length()));
    }
}
