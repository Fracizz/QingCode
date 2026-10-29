//! Separate bounded control and request queues. Control can pass queued normal
//! frames; an in-flight frame is always sent in full to preserve framing.
use super::{mpsc, Kind, SessionOutbound};

const REQUEST_DEPTH: usize = 64;
const CONTROL_DEPTH: usize = 16;

#[derive(Clone)]
pub(super) struct SessionSender {
    requests: mpsc::Sender<SessionOutbound>,
    control: mpsc::Sender<SessionOutbound>,
}

pub(super) struct SessionReceiver {
    requests: mpsc::Receiver<SessionOutbound>,
    control: mpsc::Receiver<SessionOutbound>,
}

pub(super) fn channel() -> (SessionSender, SessionReceiver) {
    let (requests, requests_rx) = mpsc::channel(REQUEST_DEPTH);
    let (control, control_rx) = mpsc::channel(CONTROL_DEPTH);
    (
        SessionSender { requests, control },
        SessionReceiver {
            requests: requests_rx,
            control: control_rx,
        },
    )
}

impl SessionSender {
    pub(super) fn try_send(
        &self,
        message: SessionOutbound,
    ) -> Result<(), mpsc::error::TrySendError<SessionOutbound>> {
        let priority = match &message {
            SessionOutbound::Shutdown => true,
            SessionOutbound::Frame(frame) => matches!(
                frame.kind,
                Kind::Ping | Kind::Pong | Kind::Cancel | Kind::Window
            ),
        };
        if priority {
            self.control.try_send(message)
        } else {
            self.requests.try_send(message)
        }
    }
}

impl SessionReceiver {
    pub(super) async fn recv(&mut self) -> Option<SessionOutbound> {
        tokio::select! {
            biased;
            Some(message) = self.control.recv() => Some(message),
            Some(message) = self.requests.recv() => Some(message),
            else => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::Frame;
    use super::*;

    #[tokio::test]
    async fn controls_survive_a_full_request_queue_and_requests_keep_their_order() {
        let (sender, mut receiver) = channel();
        for id in 0..REQUEST_DEPTH {
            assert!(sender
                .try_send(SessionOutbound::Frame(Frame::empty(Kind::Req, id as u32)))
                .is_ok());
        }
        assert!(sender
            .try_send(SessionOutbound::Frame(Frame::empty(Kind::Req, 999)))
            .is_err());
        for kind in [Kind::Ping, Kind::Pong, Kind::Cancel, Kind::Window] {
            assert!(sender
                .try_send(SessionOutbound::Frame(Frame::empty(kind, 0)))
                .is_ok());
        }
        for kind in [Kind::Ping, Kind::Pong, Kind::Cancel, Kind::Window] {
            assert!(
                matches!(receiver.recv().await, Some(SessionOutbound::Frame(frame)) if frame.kind == kind)
            );
        }
        for id in 0..REQUEST_DEPTH {
            assert!(
                matches!(receiver.recv().await, Some(SessionOutbound::Frame(frame)) if frame.kind == Kind::Req && frame.stream_id == id as u32)
            );
        }
        drop(sender);
        assert!(receiver.recv().await.is_none());
    }

    #[tokio::test]
    async fn control_overflow_is_bounded_and_closed_queues_still_drain_requests() {
        let (sender, mut receiver) = channel();
        for _ in 0..CONTROL_DEPTH {
            assert!(sender
                .try_send(SessionOutbound::Frame(Frame::empty(Kind::Ping, 0)))
                .is_ok());
        }
        assert!(sender
            .try_send(SessionOutbound::Frame(Frame::empty(Kind::Pong, 0)))
            .is_err());
        assert!(sender
            .try_send(SessionOutbound::Frame(Frame::empty(Kind::Req, 42)))
            .is_ok());
        drop(sender);
        for _ in 0..CONTROL_DEPTH {
            assert!(
                matches!(receiver.recv().await, Some(SessionOutbound::Frame(frame)) if frame.kind == Kind::Ping)
            );
        }
        assert!(
            matches!(receiver.recv().await, Some(SessionOutbound::Frame(frame)) if frame.stream_id == 42)
        );
        assert!(receiver.recv().await.is_none());
    }
}
