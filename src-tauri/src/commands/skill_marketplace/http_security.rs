use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::{redirect, Client, Url};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

const TRUSTED_HOSTS: &[&str] = &["api.github.com", "raw.githubusercontent.com", "github.com", "skills.sh"];

pub(super) fn preview_url(url: Url) -> Result<Url, String> {
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.host_str().is_some_and(|host| host.contains('.') && host.parse::<IpAddr>().is_err())
    {
        return Err("Unsupported skill preview URL".into());
    }
    Ok(url)
}

fn allowed_redirect(url: &Url, trusted_only: bool) -> bool {
    preview_url(url.clone()).is_ok()
        && (!trusted_only || url.host_str().is_some_and(|host| TRUSTED_HOSTS.contains(&host)))
}

pub(super) fn redirect_policy(trusted_only: bool) -> redirect::Policy {
    redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 5 || !allowed_redirect(attempt.url(), trusted_only) {
            attempt.error("Unsafe or excessive skill preview redirect")
        } else {
            attempt.follow()
        }
    })
}

fn public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [a, b, c, _] = address.octets();
            !(matches!(a, 0 | 10 | 127) || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 168 || (b == 0 && matches!(c, 0 | 2)) || (b == 88 && c == 99)))
                || (a == 198 && (matches!(b, 18 | 19) || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(address) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(mapped));
            }
            let segments = address.segments();
            // 只允许全球单播，排除转换、文档和特殊用途网段。
            segments[0] & 0xe000 == 0x2000
                && !(segments[0] == 0x2001 && (segments[1] < 0x0200 || segments[1] == 0x0db8))
                && segments[0] != 0x2002
                && !(segments[0] == 0x3fff && segments[1] & 0xf000 == 0)
        }
    }
}

fn public_addresses(addresses: Vec<SocketAddr>) -> std::io::Result<Addrs> {
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err(std::io::Error::other("Skill preview must resolve only to public addresses"));
    }
    Ok(Box::new(addresses.into_iter()))
}

struct PublicResolver;

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            // 将同一次解析中验证过的地址直接交给连接器，避免再次解析造成重绑定。
            Ok(public_addresses(addresses)?)
        })
    }
}

pub(super) fn preview_client() -> Result<Client, String> {
    // 任意域名不能交给代理重新解析；固定服务仍由上层使用用户配置的代理。
    Client::builder()
        .no_proxy()
        .https_only(true)
        .dns_resolver(Arc::new(PublicResolver))
        .redirect(redirect_policy(false))
        .user_agent("Termflow skill marketplace")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirects_reject_downgrades_private_literals_credentials_and_ports() {
        for target in ["http://example.com/a", "https://127.0.0.1/a", "https://[::1]/a",
            "https://user:pass@example.com/a", "https://example.com:8443/a"] {
            assert!(!allowed_redirect(&Url::parse(target).expect("URL"), false), "{target}");
        }
        assert!(allowed_redirect(&Url::parse("https://cdn.example.com/a").expect("URL"), false));
        assert!(!allowed_redirect(&Url::parse("https://cdn.example.com/a").expect("URL"), true));
        assert!(allowed_redirect(&Url::parse("https://skills.sh/a").expect("URL"), true));
    }

    #[test]
    fn resolver_rejects_private_special_and_mixed_answers_in_both_address_families() {
        for address in ["0.0.0.0", "10.0.0.1", "127.0.0.1", "100.64.0.1", "169.254.169.254",
            "172.16.0.1", "192.168.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1",
            "203.0.113.1", "224.0.0.1", "240.0.0.1", "::", "::1", "fc00::1", "fe80::1",
            "ff02::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2001:db8::1", "2002:7f00:1::1"] {
            let address = SocketAddr::new(address.parse().expect("IP"), 0);
            assert!(public_addresses(vec![address]).is_err(), "{address}");
            assert!(public_addresses(vec!["8.8.8.8:0".parse().expect("public IP"), address]).is_err());
        }
        assert!(public_addresses(Vec::new()).is_err());
        let answers = vec!["8.8.8.8:0".parse().expect("IPv4"), "[2606:4700:4700::1111]:0".parse().expect("IPv6")];
        assert_eq!(public_addresses(answers.clone()).expect("public answers").collect::<Vec<_>>(), answers);
    }
}
