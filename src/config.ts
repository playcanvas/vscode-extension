import packageJson from '../package.json';

export const EXT_NAME = packageJson.name;
export const EXT_PUBLISHER = packageJson.publisher.toLowerCase();

export const DEBUG = process.env.NODE_ENV === 'development';
export const ENV = process.env.ENV || 'prod';
export const PORT = parseInt(process.env.PORT || '61000', 10);
export const WEB = process.env.PLATFORM === 'web';
export const ROOT_FOLDER = process.env.ROOT_FOLDER || '';

export const COOKIE_NAME = process.env.COOKIE_NAME || 'pc_auth';
export const API_URL = process.env.API_URL || 'https://playcanvas.com/api';
export const HOME_URL = process.env.HOME_URL || 'https://playcanvas.com';
export const LOGIN_URL = process.env.LOGIN_URL || 'https://login.playcanvas.com';
export const MESSENGER_URL = process.env.MESSENGER_URL || 'wss://msg.playcanvas.com/messages';
export const REALTIME_URL = process.env.REALTIME_URL || 'wss://rt.playcanvas.com/realtime';
export const RELAY_URL = process.env.RELAY_URL || 'wss://relay.playcanvas.com/relay';

if (DEBUG) {
    console.table({
        EXT_NAME,
        EXT_PUBLISHER,
        DEBUG,
        ENV,
        WEB,
        ROOT_FOLDER,
        API_URL,
        HOME_URL,
        LOGIN_URL,
        MESSENGER_URL,
        REALTIME_URL,
        RELAY_URL
    });
}
