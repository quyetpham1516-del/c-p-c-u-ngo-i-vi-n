'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../src/screens/Login').then((m) => m.Login), { ssr: false });
