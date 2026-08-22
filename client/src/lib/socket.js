import { io } from 'socket.io-client';
import { API_BASE } from './api';

let socket = null;

export function getSocket() {
  if (!socket) {
    // Passing undefined (rather than an empty string) makes socket.io-client
    // connect to the page's own origin.
    socket = io(API_BASE || undefined, { autoConnect: false });
  }
  return socket;
}
