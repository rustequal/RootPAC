deny("*.google-analytics.com");
deny("*.doubleclick.net");

var PROXY = "SOCKS5 10.1.4.1:9487";

function FindProxyForURL(url, host) {
  if (root(host, "instagram.com")) return PROXY;
  return "DIRECT";
}