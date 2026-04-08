"""
动画管理器
处理各种动画效果
"""
from PyQt6.QtCore import QPropertyAnimation, QEasingCurve, QPoint, QTimer


class AnimationManager:
    """动画管理器"""
    
    def __init__(self, target_widget):
        self.target = target_widget
        self.current_animation = None
        
    def play_breathing(self):
        """播放呼吸动画（上下轻微浮动）"""
        if self.current_animation and self.current_animation.state() == QPropertyAnimation.State.Running:
            return
            
        # 保存原始位置
        original_pos = self.target.pos()
        
        # 向上移动
        self.current_animation = QPropertyAnimation(self.target, b"pos")
        self.current_animation.setDuration(1000)
        self.current_animation.setStartValue(original_pos)
        self.current_animation.setEndValue(QPoint(original_pos.x(), original_pos.y() - 5))
        self.current_animation.setEasingCurve(QEasingCurve.Type.InOutSine)
        
        # 向下返回
        self.return_animation = QPropertyAnimation(self.target, b"pos")
        self.return_animation.setDuration(1000)
        self.return_animation.setStartValue(QPoint(original_pos.x(), original_pos.y() - 5))
        self.return_animation.setEndValue(original_pos)
        self.return_animation.setEasingCurve(QEasingCurve.Type.InOutSine)
        
        # 连接动画链
        self.current_animation.finished.connect(self.return_animation.start)
        self.current_animation.start()
        
    def play_jump(self):
        """播放跳跃动画"""
        if self.current_animation and self.current_animation.state() == QPropertyAnimation.State.Running:
            self.current_animation.stop()
            
        original_pos = self.target.pos()
        
        # 向上跳
        jump_up = QPropertyAnimation(self.target, b"pos")
        jump_up.setDuration(200)
        jump_up.setStartValue(original_pos)
        jump_up.setEndValue(QPoint(original_pos.x(), original_pos.y() - 30))
        jump_up.setEasingCurve(QEasingCurve.Type.OutQuad)
        
        # 落下
        jump_down = QPropertyAnimation(self.target, b"pos")
        jump_down.setDuration(300)
        jump_down.setStartValue(QPoint(original_pos.x(), original_pos.y() - 30))
        jump_down.setEndValue(original_pos)
        jump_down.setEasingCurve(QEasingCurve.Type.InQuad)
        
        # 连接
        jump_up.finished.connect(jump_down.start)
        jump_up.start()
        
    def play_shake(self):
        """播放摇晃动画"""
        original_pos = self.target.pos()
        
        # 简单的左右摇晃
        offsets = [-5, 5, -5, 5, 0]
        delays = [50, 100, 150, 200, 250]
        
        for offset, delay in zip(offsets, delays):
            QTimer.singleShot(delay, lambda o=offset: 
                self.target.move(original_pos.x() + o, original_pos.y()))
                
    def play_bounce(self):
        """播放弹跳动画"""
        original_pos = self.target.pos()
        
        # 压缩
        squash = QPropertyAnimation(self.target, b"pos")
        squash.setDuration(100)
        squash.setStartValue(original_pos)
        squash.setEndValue(QPoint(original_pos.x(), original_pos.y() + 5))
        
        # 弹起
        bounce_up = QPropertyAnimation(self.target, b"pos")
        bounce_up.setDuration(200)
        bounce_up.setStartValue(QPoint(original_pos.x(), original_pos.y() + 5))
        bounce_up.setEndValue(QPoint(original_pos.x(), original_pos.y() - 20))
        bounce_up.setEasingCurve(QEasingCurve.Type.OutQuad)
        
        # 落下
        bounce_down = QPropertyAnimation(self.target, b"pos")
        bounce_down.setDuration(200)
        bounce_down.setStartValue(QPoint(original_pos.x(), original_pos.y() - 20))
        bounce_down.setEndValue(original_pos)
        bounce_down.setEasingCurve(QEasingCurve.Type.InQuad)
        
        # 连接
        squash.finished.connect(bounce_up.start)
        bounce_up.finished.connect(bounce_down.start)
        squash.start()
