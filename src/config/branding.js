'use strict';

/** Shared branding media. Keep links stable; Discord fetches these on render. */
const BRANDING_GIF = 'https://file.garden/am9m147l3hw3nqT1/tfw%20no%20elf%20ears.gif';
// Security Center header banner: Makise Kurisu at the lab monitor.
// The %20 must stay URL-encoded or Discord will not fetch the file.
const SECURITY_BANNER = 'https://file.garden/am9m147l3hw3nqT1/t_me_kurisu_s_makise%20(1).jpg';

module.exports = { BRANDING_GIF, SECURITY_BANNER };
