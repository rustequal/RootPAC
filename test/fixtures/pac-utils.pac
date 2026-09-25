function dnsDomainIs(host, domain) {
    return (host.length >= domain.length &&
            host.substring(host.length - domain.length) == domain);
}

function shExpMatch(url, pattern) {
   pattern = pattern.replace(/\./g, '\\.');
   pattern = pattern.replace(/\*/g, '.*');
   pattern = pattern.replace(/\?/g, '.');
   var newRe = new RegExp('^'+pattern+'$');
   return newRe.test(url);
}
