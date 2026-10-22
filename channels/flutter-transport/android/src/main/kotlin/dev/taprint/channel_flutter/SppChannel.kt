// SPDX-License-Identifier: Apache-2.0
package dev.taprint.channel_flutter

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * SPP 打印 MethodChannel 处理器（原生 BluetoothSocket 自研，不引
 * 长期停更的第三方蓝牙串口库）。
 *
 * Dart 侧对应同包的 lib/spp_executor.dart，channel 名一致
 * （SppExecutor.channelName / CHANNEL）。RFCOMM 使用 SPP 标准
 * service UUID 00001101-0000-1000-8000-00805F9B34FB。
 *
 * - connect/writeBytes/disconnect 均为阻塞 IO，统一在单线程 executor 上
 *   串行执行（防并发写交错），结果经 mainHandler 回主线程；
 * - connect 前取消系统扫描（cancelDiscovery，否则连接成功率骤降）；
 * - targetSdk>=31 时 BLUETOOTH_CONNECT 为运行时权限，本通道只做校验并
 *   返回降级错误，不弹授权 UI（授权由 Dart 侧权限流程负责；
 *   minSdk<=30 的 API 走安装时权限，无需运行时申请）。
 */
class SppChannel(
    private val context: Context,
    private val messenger: BinaryMessenger,
) : MethodChannel.MethodCallHandler {

    companion object {
        const val CHANNEL = "dev.taprint.channel_flutter/spp"

        /** SPP 标准 service UUID。 */
        val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    /** 由 ioExecutor 独占读写；主线程只做引用读写（volatile 见 [socket]）。 */
    @Volatile
    private var socket: BluetoothSocket? = null

    fun register() {
        MethodChannel(messenger, CHANNEL).setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "connect" -> connect(call.argument<String>("address"), result)
            "writeBytes" -> writeBytes(call.argument<ByteArray>("bytes"), result)
            "disconnect" -> disconnect(result)
            "isConnected" -> result.success(socket?.isConnected == true)
            else -> result.notImplemented()
        }
    }

    private fun connect(address: String?, result: MethodChannel.Result) {
        if (address.isNullOrBlank()) {
            result.error("INVALID_ADDRESS", "SPP 设备缺少 address（MAC）", null)
            return
        }
        val adapter =
            (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        if (adapter == null || !adapter.isEnabled) {
            result.error("BLUETOOTH_OFF", "蓝牙未开启", null)
            return
        }
        if (!hasConnectPermission()) {
            result.error(
                "PERMISSION_DENIED",
                "缺少 BLUETOOTH_CONNECT 运行时权限",
                null,
            )
            return
        }
        ioExecutor.execute {
            try {
                @SuppressLint("MissingPermission") // 已在上方分支校验
                val device = adapter.getRemoteDevice(address)
                closeSocketQuietly()
                // 连接期间持续扫描会显著降低 RFCOMM 成功率，先停扫描。
                @SuppressLint("MissingPermission")
                adapter.cancelDiscovery()
                val newSocket = device.createRfcommSocketToServiceRecord(SPP_UUID)
                newSocket.connect()
                socket = newSocket
                mainHandler.post { result.success(null) }
            } catch (e: IllegalArgumentException) {
                mainHandler.post {
                    result.error("INVALID_ADDRESS", "非法 MAC 地址: $address", null)
                }
            } catch (e: SecurityException) {
                mainHandler.post { result.error("PERMISSION_DENIED", e.message, null) }
            } catch (e: IOException) {
                closeSocketQuietly()
                mainHandler.post {
                    result.error("CONNECT_FAILED", "RFCOMM 连接失败: ${e.message}", null)
                }
            }
        }
    }

    private fun writeBytes(bytes: ByteArray?, result: MethodChannel.Result) {
        if (bytes == null || bytes.isEmpty()) {
            result.error("INVALID_BYTES", "写入内容为空", null)
            return
        }
        ioExecutor.execute {
            val current = socket
            if (current == null || !current.isConnected) {
                socket = null
                mainHandler.post {
                    result.error("NOT_CONNECTED", "SPP 未连接", null)
                }
                return@execute
            }
            try {
                current.outputStream.apply {
                    write(bytes)
                    flush()
                }
                mainHandler.post { result.success(null) }
            } catch (e: IOException) {
                // 写失败视为链路断：清引用，Dart 侧同口径置未连接。
                socket = null
                closeQuietly(current)
                mainHandler.post {
                    result.error("WRITE_FAILED", "SPP 写入失败: ${e.message}", null)
                }
            }
        }
    }

    private fun disconnect(result: MethodChannel.Result) {
        ioExecutor.execute {
            closeSocketQuietly()
            mainHandler.post { result.success(null) }
        }
    }

    private fun closeSocketQuietly() {
        val current = socket ?: return
        socket = null
        closeQuietly(current)
    }

    private fun closeQuietly(target: BluetoothSocket) {
        try {
            target.close()
        } catch (_: IOException) {
            // 关闭失败无需上报：调用方语义即“放弃该 socket”。
        }
    }

    /**
     * API>=31 校验 BLUETOOTH_CONNECT（Manifest 声明字符串常量编译期内联，
     * 旧设备不触发反射读取）；API<=30 安装时权限已覆盖。
     */
    private fun hasConnectPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return context.checkSelfPermission("android.permission.BLUETOOTH_CONNECT") ==
            PackageManager.PERMISSION_GRANTED
    }
}
