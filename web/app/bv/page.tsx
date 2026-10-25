'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../src/screens/ShareView').then((m) => m.ShareView), { ssr: false });
