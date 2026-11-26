package com.qingcode.next;

final class BridgeException extends Exception {
  private static final long serialVersionUID = 1L;

  final String code;

  BridgeException(String code, String message) {
    super(message);
    this.code = code;
  }
}
