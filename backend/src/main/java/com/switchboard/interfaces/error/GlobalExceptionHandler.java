package com.switchboard.interfaces.error;

import com.switchboard.domain.common.AiUnavailableException;
import com.switchboard.domain.common.ConflictException;
import com.switchboard.domain.common.ForbiddenException;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.common.ValidationException;
import com.switchboard.interfaces.rest.model.ApiError;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.bind.support.WebExchangeBindException;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebInputException;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(NotFoundException.class)
    public ResponseEntity<ApiError> notFound(NotFoundException e) {
        return body(HttpStatus.NOT_FOUND, ApiError.ErrorEnum.NOT_FOUND, e.getMessage());
    }

    @ExceptionHandler(ForbiddenException.class)
    public ResponseEntity<ApiError> forbidden(ForbiddenException e) {
        return body(HttpStatus.FORBIDDEN, ApiError.ErrorEnum.FORBIDDEN, e.getMessage());
    }

    @ExceptionHandler(ConflictException.class)
    public ResponseEntity<ApiError> conflict(ConflictException e) {
        return body(HttpStatus.CONFLICT, ApiError.ErrorEnum.CONFLICT, e.getMessage());
    }

    @ExceptionHandler(ValidationException.class)
    public ResponseEntity<ApiError> validation(ValidationException e) {
        return body(HttpStatus.BAD_REQUEST, ApiError.ErrorEnum.VALIDATION_FAILED, e.getMessage());
    }

    @ExceptionHandler(AiUnavailableException.class)
    public ResponseEntity<ApiError> aiUnavailable(AiUnavailableException e) {
        return body(HttpStatus.SERVICE_UNAVAILABLE, ApiError.ErrorEnum.AI_UNAVAILABLE, e.getMessage());
    }

    @ExceptionHandler(WebExchangeBindException.class)
    public ResponseEntity<ApiError> bindFailure(WebExchangeBindException e) {
        return body(HttpStatus.BAD_REQUEST, ApiError.ErrorEnum.VALIDATION_FAILED, e.getReason());
    }

    @ExceptionHandler(ServerWebInputException.class)
    public ResponseEntity<ApiError> inputFailure(ServerWebInputException e) {
        return body(HttpStatus.BAD_REQUEST, ApiError.ErrorEnum.VALIDATION_FAILED, e.getReason());
    }

    /** Framework statuses (404 no handler, 405, 406...) pass through instead of hitting the 500 catch-all. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<ApiError> responseStatus(ResponseStatusException e) {
        HttpStatus status = HttpStatus.resolve(e.getStatusCode().value());
        if (status == null) {
            status = HttpStatus.INTERNAL_SERVER_ERROR;
        }
        ApiError.ErrorEnum code = switch (status) {
            case NOT_FOUND -> ApiError.ErrorEnum.NOT_FOUND;
            case FORBIDDEN -> ApiError.ErrorEnum.FORBIDDEN;
            case UNAUTHORIZED -> ApiError.ErrorEnum.UNAUTHORIZED;
            case CONFLICT -> ApiError.ErrorEnum.CONFLICT;
            default -> ApiError.ErrorEnum.VALIDATION_FAILED;
        };
        return body(status, code, e.getReason());
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> unexpected(Exception e) {
        log.error("Unhandled error", e);
        return body(HttpStatus.INTERNAL_SERVER_ERROR, ApiError.ErrorEnum.VALIDATION_FAILED, "Internal error");
    }

    private static ResponseEntity<ApiError> body(HttpStatus status, ApiError.ErrorEnum code, String message) {
        return ResponseEntity.status(status)
            .body(new ApiError(code, message == null ? code.getValue() : message));
    }
}
