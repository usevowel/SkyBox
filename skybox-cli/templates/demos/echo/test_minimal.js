export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname === '/__health') return new Response('OK');
        return new Response('bare worker works');
    },
};
