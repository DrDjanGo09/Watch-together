import { io } from 'socket.io-client';
import { API_BASE } from './api';

let socket = null;

export function getSocket() {
  if (!socket) {
    socket = io(API_BASE, { autoConnect: false });
  }
  return socket;
}
