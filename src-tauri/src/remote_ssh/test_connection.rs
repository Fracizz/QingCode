//! Disposable loopback SSH/SFTP acceptance for the isolated connection test.
use super::*;
use russh::server::{self, Server as _};
use std::sync::atomic::AtomicUsize;

#[derive(Default)]
struct TestServer {
    attempts: Arc<AtomicUsize>,
    channels: HashMap<russh::ChannelId, russh::Channel<server::Msg>>,
}

impl server::Server for TestServer {
    type Handler = Self;

    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        Self {
            attempts: Arc::clone(&self.attempts),
            channels: HashMap::new(),
        }
    }
}

impl server::Handler for TestServer {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        Ok(if user == "test-user" && password == "test-password" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        id: russh::ChannelId,
        name: &str,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if name == "sftp" {
            let channel = self.channels.remove(&id).unwrap();
            session.channel_success(id)?;
            tokio::spawn(russh_sftp::server::run(channel.into_stream(), TestSftp));
        } else {
            session.channel_failure(id)?;
        }
        Ok(())
    }
}

struct TestSftp;

impl russh_sftp::server::Handler for TestSftp {
    type Error = russh_sftp::protocol::StatusCode;

    fn unimplemented(&self) -> Self::Error {
        russh_sftp::protocol::StatusCode::OpUnsupported
    }

    async fn realpath(
        &mut self,
        id: u32,
        _: String,
    ) -> Result<russh_sftp::protocol::Name, Self::Error> {
        Ok(russh_sftp::protocol::Name {
            id,
            files: vec![russh_sftp::protocol::File::dummy("/home/test-user")],
        })
    }
}

#[tokio::test]
async fn tests_reauthenticate_without_mutating_a_live_session() {
    let key = russh::keys::PrivateKey::from(
        russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[42; 32]),
    );
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut server = TestServer::default();
    let attempts = Arc::clone(&server.attempts);
    let config = Arc::new(server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let task = tokio::spawn(async move { server.run_on_socket(config, &listener).await });
    let config = SshConnectionConfig {
        id: "existing-connection".into(),
        host: "127.0.0.1".into(),
        port,
        username: "test-user".into(),
        auth_kind: "password".into(),
        password: Some("test-password".into()),
        private_key_path: None,
        passphrase: None,
        host_key_fingerprint: Some(fingerprint.clone()),
        mode: Some(RemoteMode::Server),
    };
    let manager = SshManager::new();
    let (original, _) = store_authenticated_session(&manager, config.clone())
        .await
        .unwrap();
    // Reusing the live connection to browse a second project does not require
    // resending its secret, and must preserve that secret for later reconnects.
    let mut browse = config.clone();
    browse.password = None;
    browse.passphrase = None;
    browse.mode = None;
    manager.remember_config(&config.id, browse).unwrap();
    assert_eq!(original.config.lock().unwrap().password, config.password);
    assert_eq!(original.config.lock().unwrap().mode, config.mode);
    assert_eq!(attempts.load(Ordering::SeqCst), 1);

    let mut changed = config.clone();
    changed.username = "different-user".into();
    assert!(manager.remember_config(&config.id, changed).is_err());
    assert_eq!(original.config.lock().unwrap().username, config.username);
    for wrong_user in [false, true] {
        let mut wrong = config.clone();
        if wrong_user {
            wrong.username = "wrong-user".into();
        } else {
            wrong.password = Some("wrong-password".into());
        }
        assert!(ssh_test_connection(wrong).await.is_err());
        assert!(Arc::ptr_eq(
            &original,
            &manager.session(&config.id).unwrap()
        ));
        assert!(!original.handle.is_closed());
        assert_eq!(original.config.lock().unwrap().password, config.password);
        assert_eq!(original.config.lock().unwrap().username, config.username);
    }
    let tested = ssh_test_connection(config.clone()).await.unwrap();
    assert_eq!(tested.fingerprint, fingerprint);
    assert_eq!(tested.home_path, "/home/test-user");
    assert_eq!(attempts.load(Ordering::SeqCst), 4);
    assert!(Arc::ptr_eq(
        &original,
        &manager.session(&config.id).unwrap()
    ));
    assert!(!original.handle.is_closed());
    assert_eq!(manager.sessions.read().unwrap().len(), 1);
    let _ = original
        .handle
        .disconnect(Disconnect::ByApplication, "test complete", "en")
        .await;
    task.abort();
}
