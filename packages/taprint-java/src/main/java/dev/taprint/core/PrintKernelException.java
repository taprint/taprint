/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.core;

/**
 * Exception type of the rendering kernel. Replaces the host application's
 * business exception so the kernel carries no framework dependency.
 */
public class PrintKernelException extends RuntimeException {

    private final PrintErrorCode errorCode;

    private PrintKernelException(PrintErrorCode errorCode, String message, Throwable cause) {
        super(message == null || message.isEmpty()
                ? errorCode.getDefaultMessage() : message, cause);
        this.errorCode = errorCode;
    }

    public static Builder builder() {
        return new Builder();
    }

    public static PrintKernelException of(PrintErrorCode errorCode) {
        return new PrintKernelException(errorCode, null, null);
    }

    public static PrintKernelException of(PrintErrorCode errorCode, String message) {
        return new PrintKernelException(errorCode, message, null);
    }

    public static PrintKernelException of(PrintErrorCode errorCode, String message, Throwable cause) {
        return new PrintKernelException(errorCode, message, cause);
    }

    public PrintErrorCode getErrorCode() {
        return errorCode;
    }

    /** Fluent construction helper. */
    public static final class Builder {

        private PrintErrorCode errorCode;
        private String message;
        private Throwable cause;

        public Builder errorCode(PrintErrorCode errorCode) {
            this.errorCode = errorCode;
            return this;
        }

        public Builder message(String message) {
            this.message = message;
            return this;
        }

        public Builder cause(Throwable cause) {
            this.cause = cause;
            return this;
        }

        public PrintKernelException build() {
            return new PrintKernelException(errorCode, message, cause);
        }
    }
}
